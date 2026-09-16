import { randomUUID } from 'node:crypto';
import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
import type {
	AbstractServiceOptions,
	Item,
	PrimaryKey,
	QualityFinding,
	QualityRule,
	QualityRun,
	Query,
} from '@directus/types';
import { parseJSON } from '@directus/utils';
import { fetchAllowedFields } from '../permissions/modules/fetch-allowed-fields/fetch-allowed-fields.js';
import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
import { ItemsService } from './items.js';
import { isQualityViolation, validateQualityRuleConfiguration } from './quality-rules-lib.js';

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;

export class QualityRunsService extends ItemsService<QualityRun> {
	private static activeScans = new Map<string, AbortController>();
	private static ruleRuns = new Map<string, Set<string>>();

	constructor(options: AbstractServiceOptions) {
		super('directus_quality_runs', options);
	}

	static cancelRule(ruleId: PrimaryKey): void {
		for (const runId of QualityRunsService.ruleRuns.get(String(ruleId)) ?? []) {
			QualityRunsService.activeScans.get(runId)?.abort();
		}
	}

	override async readByQuery(query: Query, opts?: Parameters<ItemsService<QualityRun>['readByQuery']>[1]) {
		const runs = await super.readByQuery(query, opts);

		if (this.accountability?.admin === true || runs.length === 0) return runs;

		const ruleIds = [...new Set(runs.map((run) => run.rule))];

		const rules = await this.knex('directus_quality_rules').select('id', 'collection', 'fields').whereIn('id', ruleIds);

		if (this.accountability) {
			const allowedRules = new Set<string>();

			for (const rule of rules) {
				const allowed = await this.canReadTarget(rule.collection, this.parseJsonArray(rule.fields));
				if (allowed) allowedRules.add(String(rule.id));
			}

			return runs.filter((run) => allowedRules.has(String(run.rule)));
		}

		return runs;
	}

	override async createOne(): Promise<PrimaryKey> {
		throw new ForbiddenError();
	}

	override async updateMany(): Promise<PrimaryKey[]> {
		throw new ForbiddenError();
	}

	override async deleteMany(): Promise<PrimaryKey[]> {
		throw new ForbiddenError();
	}

	async start(ruleId: PrimaryKey, trigger: 'manual' | 'schedule' = 'manual'): Promise<PrimaryKey | null> {
		if (this.accountability && this.accountability.admin !== true) throw new ForbiddenError();

		const rule = await this.knex.select('*').from('directus_quality_rules').where('id', ruleId).first();

		if (!rule) throw new ForbiddenError();
		if (trigger === 'schedule' && rule.status !== 'active') return null;

		const activeRun = await this.knex('directus_quality_runs')
			.where({ rule: ruleId })
			.whereIn('status', ['queued', 'running'])
			.first('id');

		if (activeRun) {
			throw new InvalidPayloadError({ reason: 'This quality rule is already running' });
		}

		const runId = randomUUID();

		await this.knex('directus_quality_runs').insert({
			id: runId,
			rule: rule.id,
			rule_version: rule.version,
			trigger,
			status: 'queued',
			batch_size: DEFAULT_BATCH_SIZE,
			scanned_count: 0,
			finding_count: 0,
			user_created: this.accountability?.user ?? null,
		});

		void this.scan(runId).catch(() => {
			// scan() records all execution errors on the run row
		});

		return runId;
	}

	async cancel(runId: PrimaryKey): Promise<void> {
		const run = await this.knex('directus_quality_runs').where('id', runId).first('id', 'rule', 'status');
		if (!run) throw new ForbiddenError();

		if (!['queued', 'running'].includes(run.status)) return;

		if (this.accountability && this.accountability.admin !== true) throw new ForbiddenError();

		await this.knex('directus_quality_runs')
			.where('id', runId)
			.update({ status: 'canceled', date_finished: this.knex.fn.now(), error: 'Canceled before completion' });

		QualityRunsService.activeScans.get(String(runId))?.abort();
	}

	async listFindings(ruleId: PrimaryKey, query: Query = {}): Promise<{ data: Item[]; meta: number }> {
		const rule = await this.knex('directus_quality_rules').where('id', ruleId).first('*');
		if (!rule) throw new ForbiddenError();

		const allowed = await this.canReadTarget(rule.collection, this.parseJsonArray(rule.fields));
		if (!allowed) throw new ForbiddenError();

		const run = await this.knex('directus_quality_runs')
			.where({ rule: ruleId, status: 'completed' })
			.orderBy('date_finished', 'desc')
			.first('id');

		if (!run) return { data: [], meta: 0 };

		const page = Math.max(1, Number(query['page'] ?? 1));
		const limit = Math.min(MAX_BATCH_SIZE, Math.max(1, Number(query['limit'] ?? DEFAULT_BATCH_SIZE)));

		const baseQuery = this.knex('directus_quality_findings').where({ run: run.id });

		const countResult = await this.knex('directus_quality_findings')
			.where({ run: run.id })
			.count<{ count: number }[]>('* as count');

		if (this.accountability && this.accountability.admin !== true) {
			const allRows = await this.knex('directus_quality_findings')
				.select('id', 'run', 'rule', 'collection', 'item', 'fields', 'message', 'date_created')
				.where({ run: run.id })
				.orderBy('id');

			const normalizedRows = allRows.map((row) => this.normalizeFindingRow(row));
			const accessibleRows: Item[] = [];
			const primaryKeyField = this.schema.collections[rule.collection]!.primary;

			for (let index = 0; index < normalizedRows.length; index += MAX_BATCH_SIZE) {
				const chunk = normalizedRows.slice(index, index + MAX_BATCH_SIZE);

				const accessibleItems = await new ItemsService(rule.collection, {
					knex: this.knex,
					schema: this.schema,
					accountability: this.accountability,
				}).readByQuery({
					fields: [primaryKeyField],
					filter: { [primaryKeyField]: { _in: chunk.map((row) => row['item']) } },
					limit: -1,
				});

				const accessibleKeys = new Set(accessibleItems.map((item) => String(item[primaryKeyField])));
				accessibleRows.push(...chunk.filter((row) => accessibleKeys.has(String(row['item']))));
			}

			return {
				data: accessibleRows.slice((page - 1) * limit, page * limit),
				meta: accessibleRows.length,
			};
		}

		const rows = await baseQuery
			.select('id', 'run', 'rule', 'collection', 'item', 'fields', 'message', 'date_created')
			.orderBy('id')
			.limit(limit)
			.offset((page - 1) * limit);

		return { data: rows.map((row) => this.normalizeFindingRow(row)), meta: Number(countResult[0]?.count ?? 0) };
	}

	async listAccessibleRules(): Promise<{ id: string; name: string }[]> {
		const rules = await this.knex('directus_quality_rules')
			.select('id', 'name', 'collection', 'fields', 'status')
			.where({ status: 'active' })
			.orderBy('name');

		const accessible: { id: string; name: string }[] = [];

		for (const rule of rules) {
			if (await this.canReadTarget(rule.collection, this.parseJsonArray(rule.fields))) {
				accessible.push({ id: rule.id, name: rule.name });
			}
		}

		return accessible;
	}

	async getPanelContext(ruleId: PrimaryKey): Promise<{ collection: string } | null> {
		const rule = await this.knex('directus_quality_rules').where('id', ruleId).first('id', 'collection', 'fields');
		if (!rule) throw new ForbiddenError();

		if (!(await this.canReadTarget(rule.collection, this.parseJsonArray(rule.fields)))) return null;

		return { collection: rule.collection };
	}

	private async scan(runId: string): Promise<void> {
		const controller = new AbortController();
		QualityRunsService.activeScans.set(runId, controller);

		try {
			let run = await this.knex('directus_quality_runs').where('id', runId).first('*');
			if (!run || run.status === 'canceled') return;

			const ruleRow = await this.knex('directus_quality_rules').where('id', run.rule).first('*');
			if (!ruleRow) throw new InvalidPayloadError({ reason: 'Quality rule was deleted' });
			const rule = ruleRow as QualityRule;

			const collection = this.schema.collections[rule.collection];
			if (!collection) throw new InvalidPayloadError({ reason: `Collection "${rule.collection}" no longer exists` });

			const fields = this.parseJsonArray(rule.fields);
			validateQualityRuleConfiguration(rule.type, collection, fields, this.schema.relations);

			const relations = new Map(
				this.schema.relations
					.filter((relation) => relation.collection === rule.collection && fields.includes(relation.field))
					.map((relation) => [relation.field, relation]),
			);

			if (!QualityRunsService.ruleRuns.has(rule.id)) QualityRunsService.ruleRuns.set(rule.id, new Set());
			QualityRunsService.ruleRuns.get(rule.id)!.add(runId);

			await this.knex('directus_quality_runs')
				.where('id', runId)
				.update({ status: 'running', date_started: this.knex.fn.now() });

			await this.knex('directus_quality_findings').where('run', runId).delete();

			const primaryKeyField = collection.primary;
			const batchSize = Number(run.batch_size) || DEFAULT_BATCH_SIZE;
			let lastScannedKey: PrimaryKey | null = null;
			let scanned = 0;
			const findings: QualityFinding[] = [];

			while (true) {
				run = await this.knex('directus_quality_runs').where('id', runId).first('status');

				if (run?.status === 'canceled' || controller.signal.aborted) return;

				let pageKeys: PrimaryKey[];
				const rows: Record<string, unknown>[] = [];
				const failedFieldsByItem = new Map<string, string[]>();

				if (rule.type === 'broken_relation') {
					// Distinct subquery paginates over orphan items so JOIN row multiplication can't skew paging
					const orphanKeysQuery = this.knex(rule.collection)
						.distinct(`${rule.collection}.${primaryKeyField} as ${primaryKeyField}`)
						.orderBy(`${rule.collection}.${primaryKeyField}`)
						.limit(batchSize)
						.modify((builder) => {
							if (lastScannedKey !== null) {
								builder.where(`${rule.collection}.${primaryKeyField}`, '>', lastScannedKey);
							}
						});

					fields.forEach((field: string, index: number) => {
						const relation = relations.get(field)!;
						const alias = `__qr_parent_${index}`;
						const parentPrimary = this.schema.collections[relation.related_collection!]!.primary;

						orphanKeysQuery.leftJoin(
							`${relation.related_collection} as ${alias}`,
							`${rule.collection}.${field}`,
							`${alias}.${parentPrimary}`,
						);
					});

					orphanKeysQuery.where((whereBuilder) => {
						fields.forEach((field: string, index: number) => {
							const relation = relations.get(field)!;
							const parentPrimary = this.schema.collections[relation.related_collection!]!.primary;

							whereBuilder.orWhere((clause) => {
								clause.whereNotNull(`${rule.collection}.${field}`).whereNull(`__qr_parent_${index}.${parentPrimary}`);
							});
						});
					});

					const orphanKeyRows: Record<string, unknown>[] = await orphanKeysQuery;
					pageKeys = orphanKeyRows.map((row) => row[primaryKeyField] as PrimaryKey);

					if (pageKeys.length === 0) break;

					rows.push(
						...(await this.knex(rule.collection)
							.select(primaryKeyField, ...fields)
							.whereIn(primaryKeyField, pageKeys)
							.orderBy(primaryKeyField)),
					);

					for (const [index, field] of fields.entries()) {
						const relation = relations.get(field)!;
						const alias = `__qr_parent_${index}`;
						const parentPrimary = this.schema.collections[relation.related_collection!]!.primary;

						const brokenRows = await this.knex(rule.collection)
							.select(`${rule.collection}.${primaryKeyField} as ${primaryKeyField}`)
							.leftJoin(
								`${relation.related_collection} as ${alias}`,
								`${rule.collection}.${field}`,
								`${alias}.${parentPrimary}`,
							)
							.whereIn(`${rule.collection}.${primaryKeyField}`, pageKeys)
							.whereNotNull(`${rule.collection}.${field}`)
							.whereNull(`${alias}.${parentPrimary}`);

						for (const brokenRow of brokenRows) {
							const key = String(brokenRow[primaryKeyField]);
							const failedFields = failedFieldsByItem.get(key) ?? [];
							failedFields.push(field);
							failedFieldsByItem.set(key, failedFields);
						}
					}

					for (const row of rows) {
						const failedFields = failedFieldsByItem.get(String(row[primaryKeyField]));
						if (!failedFields || failedFields.length === 0) continue;

						findings.push(this.buildFinding(runId, rule, row, primaryKeyField, failedFields));
					}
				} else {
					const pageRows: Record<string, unknown>[] = await this.knex(rule.collection)
						.select(primaryKeyField, ...fields)
						.orderBy(primaryKeyField)
						.limit(batchSize)
						.modify((builder) => {
							if (lastScannedKey !== null) builder.where(primaryKeyField, '>', lastScannedKey);
						});

					rows.push(...pageRows);
					pageKeys = pageRows.map((row) => row[primaryKeyField] as PrimaryKey);

					for (const row of rows) {
						const failedFields = fields.filter((field: string) => isQualityViolation(rule.type, row[field]));

						if (failedFields.length > 0) {
							findings.push(this.buildFinding(runId, rule, row, primaryKeyField, failedFields));
						}
					}
				}

				if (pageKeys.length === 0) break;

				scanned += pageKeys.length;
				lastScannedKey = pageKeys[pageKeys.length - 1] ?? lastScannedKey;

				await this.knex('directus_quality_runs').where('id', runId).update({
					scanned_count: scanned,
					finding_count: findings.length,
				});

				if (pageKeys.length < batchSize) break;
			}

			if (findings.length > 0) await this.insertFindings(findings);

			// Don't overwrite a cancellation that arrived while the final batch was scanning
			const updated = await this.knex('directus_quality_runs')
				.where('id', runId)
				.whereNot('status', 'canceled')
				.update({
					status: 'completed',
					scanned_count: scanned,
					finding_count: findings.length,
					error: null,
					date_finished: this.knex.fn.now(),
				});

			if (updated === 0) {
				await this.knex('directus_quality_runs').where('id', runId).update({
					scanned_count: scanned,
					finding_count: findings.length,
				});
			}
		} catch (error) {
			if ((error as Error).name === 'AbortError') return;

			await this.knex('directus_quality_runs')
				.where('id', runId)
				.whereNot('status', 'canceled')
				.update({
					status: 'failed',
					error: error instanceof Error ? error.message : String(error),
					date_finished: this.knex.fn.now(),
				});
		} finally {
			QualityRunsService.activeScans.delete(runId);

			for (const runs of QualityRunsService.ruleRuns.values()) {
				runs.delete(runId);
			}
		}
	}

	private buildFinding(
		runId: string,
		rule: QualityRule,
		row: Record<string, unknown>,
		primaryKeyField: string,
		failedFields: string[],
	): QualityFinding {
		return {
			id: randomUUID(),
			run: runId,
			rule: rule.id,
			collection: rule.collection,
			item: String(row[primaryKeyField]),
			fields: failedFields,
			message: null,
		};
	}

	private async canReadTarget(collection: string, fields: string[]): Promise<boolean> {
		if (!this.accountability || this.accountability.admin === true) return true;
		if (!(collection in this.schema.collections)) return false;

		try {
			await validateAccess(
				{
					collection,
					action: 'read',
					accountability: this.accountability,
				},
				{ knex: this.knex, schema: this.schema },
			);
		} catch {
			return false;
		}

		const allowedFields = await fetchAllowedFields(
			{ accountability: this.accountability, action: 'read', collection },
			{ knex: this.knex, schema: this.schema },
		);

		return fields.every((field) => allowedFields.includes('*') || allowedFields.includes(field));
	}

	private normalizeFindingRow(row: Item): Item {
		return { ...row, fields: this.parseJsonArray(row['fields']) };
	}

	private parseJsonArray(value: unknown): string[] {
		const parsed = Array.isArray(value) ? value : parseJSON(String(value));
		return Array.isArray(parsed) ? parsed.map(String) : [];
	}

	private async insertFindings(findings: QualityFinding[]): Promise<void> {
		const rows = findings.map((finding) => ({ ...finding, fields: JSON.stringify(finding.fields) }));

		for (let index = 0; index < rows.length; index += DEFAULT_BATCH_SIZE) {
			await this.knex.batchInsert('directus_quality_findings', rows.slice(index, index + DEFAULT_BATCH_SIZE), 100);
		}
	}

	async recoverInterruptedRuns(): Promise<void> {
		await this.knex('directus_quality_runs').whereIn('status', ['queued', 'running']).update({
			status: 'failed',
			error: 'Interrupted before completion',
			date_finished: this.knex.fn.now(),
		});
	}
}
