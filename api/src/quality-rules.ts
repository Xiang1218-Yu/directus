import type { QualityRule } from '@directus/types';
import PQueue from 'p-queue';
import { useBus } from './bus/index.js';
import getDatabase from './database/index.js';
import { useLogger } from './logger/index.js';
import { getSchema } from './utils/get-schema.js';
import { type ScheduledJob, scheduleSynchronizedJob, validateCron } from './utils/schedule.js';

type QualityRuleMessage = { type: 'reload' };

export class QualityRuleManager {
	private jobs = new Map<string, ScheduledJob>();
	private reloadQueue = new PQueue({ concurrency: 1 });
	private loaded = false;

	constructor() {
		useBus().subscribe<QualityRuleMessage>('quality-rules', (event: QualityRuleMessage) => {
			if (event.type === 'reload') {
				this.reloadQueue.add(async () => {
					if (this.loaded) {
						await this.unload();
						await this.load();
					}
				});
			}
		});
	}

	async initialize(): Promise<void> {
		if (!this.loaded) await this.load();
	}

	async reload(): Promise<void> {
		useBus().publish<QualityRuleMessage>('quality-rules', { type: 'reload' });
	}

	private async load(): Promise<void> {
		const logger = useLogger();
		const knex = getDatabase();
		const schema = await getSchema();

		if (!('directus_quality_rules' in schema.collections)) return;

		const { QualityRunsService } = await import('./services/quality-runs.js');
		const service = new QualityRunsService({ knex, schema });
		await service.recoverInterruptedRuns();

		const rules = await knex
			.select('*')
			.from('directus_quality_rules')
			.where({ status: 'active' })
			.whereNotNull('schedule');

		for (const rule of rules as QualityRule[]) {
			if (!rule.schedule || !validateCron(rule.schedule)) {
				logger.warn(`Quality rule "${rule.id}" has an invalid schedule and was not registered`);
				continue;
			}

			const job = scheduleSynchronizedJob(`quality-rule:${rule.id}`, rule.schedule, async () => {
				try {
					const runs = new QualityRunsService({ knex, schema: await getSchema() });
					await runs.start(rule.id, 'schedule');
				} catch (error) {
					logger.error(error);
				}
			});

			this.jobs.set(rule.id, job);
		}

		this.loaded = true;
	}

	private async unload(): Promise<void> {
		for (const job of this.jobs.values()) {
			await job.stop();
		}

		this.jobs.clear();
		this.loaded = false;
	}
}

let manager: QualityRuleManager | undefined;

export function getQualityRuleManager(): QualityRuleManager {
	if (!manager) manager = new QualityRuleManager();
	return manager;
}

export async function reloadQualityRules(): Promise<void> {
	await getQualityRuleManager().reload();
}
