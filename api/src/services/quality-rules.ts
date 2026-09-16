import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
import type {
	AbstractServiceOptions,
	Item,
	MutationOptions,
	PrimaryKey,
	QualityRuleStatus,
	QualityRuleType,
} from '@directus/types';
import { isEqual } from 'lodash-es';
import { reloadQualityRules } from '../quality-rules.js';
import { validateCron } from '../utils/schedule.js';
import { ItemsService } from './items.js';
import { validateQualityRuleConfiguration } from './quality-rules-lib.js';
import { QualityRunsService } from './quality-runs.js';

const RULE_TYPES = new Set<QualityRuleType>(['empty', 'broken_relation']);
const CONFIG_FIELDS = new Set(['name', 'description', 'collection', 'fields', 'type', 'options']);

export class QualityRulesService extends ItemsService<Item> {
	constructor(options: AbstractServiceOptions) {
		super('directus_quality_rules', options);
	}

	private assertAdmin(): void {
		if (this.accountability?.admin !== true || !this.accountability) throw new ForbiddenError();
	}

	override async createOne(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		this.assertAdmin();
		const payload = this.preparePayload(data);
		this.validateMergedConfiguration(payload);
		const result = await super.createOne(payload, opts);

		await reloadQualityRules();
		return result;
	}

	override async createMany(data: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		this.assertAdmin();
		const payloads = data.map((item) => this.preparePayload(item));

		for (const payload of payloads) {
			this.validateMergedConfiguration(payload);
		}

		const result = await super.createMany(payloads, opts);

		await reloadQualityRules();
		return result;
	}

	override async updateMany(keys: PrimaryKey[], data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		this.assertAdmin();
		const payload = this.preparePayload(data, keys.length > 1);

		if (Object.keys(payload).length > 0) {
			const existing = await super.readMany(keys, {
				fields: ['*'],
				limit: -1,
			});

			for (const rule of existing) {
				this.validateMergedConfiguration({
					...rule,
					...payload,
					fields: (payload['fields'] as string[] | undefined) ?? (rule['fields'] as string[]),
					type: (payload['type'] as QualityRuleType | undefined) ?? (rule['type'] as QualityRuleType),
				});
			}

			const changesConfig = existing.some((rule) =>
				[...CONFIG_FIELDS].some((field) => field in payload && !isEqual(payload[field], rule[field])),
			);

			if (changesConfig) {
				payload['version'] = Math.max(...existing.map((rule) => Number(rule['version']) || 1)) + 1;
			}
		}

		const result = await super.updateMany(keys, payload, opts);

		await reloadQualityRules();
		return result;
	}

	override async deleteMany(keys: PrimaryKey[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		this.assertAdmin();

		await Promise.all(
			keys.map((key) =>
				this.knex('directus_quality_runs')
					.where({ rule: key, status: 'running' })
					.update({ status: 'canceled', date_finished: this.knex.fn.now(), error: 'Rule was deleted' }),
			),
		);

		keys.forEach((key) => QualityRunsService.cancelRule(key));

		const result = await super.deleteMany(keys, opts);
		await reloadQualityRules();

		return result;
	}

	private preparePayload(data: Partial<Item>, partial = false): Partial<Item> {
		const payload = { ...data };

		if (!partial || 'name' in payload) {
			if (typeof payload['name'] !== 'string' || payload['name'].trim().length === 0) {
				throw new InvalidPayloadError({ reason: '"name" is required' });
			}
		}

		if (!partial || 'collection' in payload) {
			if (typeof payload['collection'] !== 'string' || payload['collection'].trim().length === 0) {
				throw new InvalidPayloadError({ reason: '"collection" is required' });
			}
		}

		if (!partial || 'fields' in payload) {
			let fields = payload['fields'];

			if (typeof fields === 'string') {
				fields = fields.split(',').map((field) => field.trim());
			}

			if (
				!Array.isArray(fields) ||
				fields.length === 0 ||
				fields.some((field) => typeof field !== 'string' || !field)
			) {
				throw new InvalidPayloadError({ reason: '"fields" must contain at least one field' });
			}

			payload['fields'] = [...new Set(fields)];
		}

		if (!partial || 'type' in payload) {
			if (!payload['type'] || !RULE_TYPES.has(payload['type'] as QualityRuleType)) {
				throw new InvalidPayloadError({ reason: `"type" must be one of ${[...RULE_TYPES].join(', ')}` });
			}
		}

		if ('schedule' in payload) {
			if (payload['schedule'] !== null && (!payload['schedule'] || !validateCron(String(payload['schedule'])))) {
				throw new InvalidPayloadError({ reason: '"schedule" must be a valid cron expression or null' });
			}
		}

		if ('status' in payload && payload['status'] && !['active', 'inactive'].includes(String(payload['status']))) {
			throw new InvalidPayloadError({ reason: '"status" must be active or inactive' });
		}

		if (payload['options'] !== undefined && payload['options'] !== null && typeof payload['options'] !== 'object') {
			throw new InvalidPayloadError({ reason: '"options" must be an object' });
		}

		return payload;
	}

	private validateMergedConfiguration(data: Partial<Item>): void {
		const collectionName = data['collection'] as string;
		const collection = this.schema.collections[collectionName];
		if (!collection) throw new InvalidPayloadError({ reason: `Collection "${collectionName}" does not exist` });

		validateQualityRuleConfiguration(
			data['type'] as QualityRuleType,
			collection,
			data['fields'] as string[],
			this.schema.relations,
		);
	}

	getStatuses(): QualityRuleStatus[] {
		return ['active', 'inactive'];
	}
}
