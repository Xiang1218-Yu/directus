import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useEnv } from '@directus/env';
import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
import type {
	AbstractServiceOptions,
	DeploymentImpactPermissionChange,
	DeploymentImpactReport,
	DeploymentImpactReportResult,
	Permission,
	PrimaryKey,
	Snapshot,
	SnapshotDiff,
} from '@directus/types';
import { DiffKind } from '@directus/types';
import { useLogger } from '../logger/index.js';
import { getMilliseconds } from '../utils/get-milliseconds.js';
import { getSnapshotDiff } from '../utils/schema/get-snapshot-diff.js';
import { getSnapshot } from '../utils/schema/get-snapshot.js';
import { validateSnapshot } from '../utils/schema/validate-snapshot.js';
import { DeploymentRunsService } from './deployment-runs.js';
import { ItemsService } from './items.js';

type ImpactReportRecord = Omit<DeploymentImpactReport, 'requested_snapshot' | 'requested_permissions' | 'result'> & {
	requested_snapshot: string | Snapshot | null;
	requested_permissions: string | Permission[] | null;
	result: string | DeploymentImpactReportResult | null;
};

const MAX_ATTEMPTS = 3;

export class DeploymentImpactReportsService extends ItemsService<DeploymentImpactReport> {
	constructor(options: AbstractServiceOptions) {
		super('directus_deployment_impact_reports', options);
	}

	override async readByQuery<UserQuery extends Parameters<ItemsService<DeploymentImpactReport>['readByQuery']>[0]>(
		query?: UserQuery,
	): Promise<any[]> {
		await this.assertCanReadReports();
		await this.markExpiredReports();
		const reports = (await super.readByQuery(query ?? {})) as ImpactReportRecord[];
		return Promise.all(reports.map((report) => this.serialize(report)));
	}

	override async readOne<UserKey extends PrimaryKey>(
		key: UserKey,
		query?: Parameters<ItemsService<DeploymentImpactReport>['readOne']>[1],
		action?: Parameters<ItemsService<DeploymentImpactReport>['readOne']>[2],
	): Promise<any> {
		await this.assertCanReadReports();
		await this.markExpiredReports();
		const report = (await super.readOne(key, query, action)) as ImpactReportRecord;
		return this.serialize(report);
	}

	private async assertCanReadReports(): Promise<void> {
		if (this.accountability?.admin) return;

		const requiredCollections = ['directus_deployments'];

		for (const collection of requiredCollections) {
			try {
				const service = new ItemsService(collection, {
					knex: this.knex,
					schema: this.schema,
					accountability: this.accountability,
				});

				await service.readByQuery({ aggregate: { count: ['*'] }, limit: 1 });
			} catch {
				throw new ForbiddenError();
			}
		}
	}

	async createReport(input: {
		snapshot: Snapshot;
		permissions?: Permission[];
		deploymentRun?: PrimaryKey;
		deploymentProject?: PrimaryKey;
		deployment?: PrimaryKey;
	}): Promise<DeploymentImpactReport> {
		if (!this.accountability?.admin) throw new ForbiddenError();
		if (!input.snapshot) throw new InvalidPayloadError({ reason: 'A schema snapshot is required' });

		validateSnapshot(input.snapshot, true);

		let deployment: PrimaryKey | null = input.deployment ?? null;
		const deploymentRun: PrimaryKey | null = input.deploymentRun ?? null;
		let deploymentProject: PrimaryKey | null = input.deploymentProject ?? null;

		if (deploymentRun) {
			const runsService = new DeploymentRunsService({
				knex: this.knex,
				schema: this.schema,
				accountability: null,
			});

			const run = await runsService.readOne(deploymentRun);

			const projectsService = new ItemsService('directus_deployment_projects', {
				knex: this.knex,
				schema: this.schema,
				accountability: null,
			});

			const project = (await projectsService.readOne(run.project)) as {
				id: PrimaryKey;
				deployment: PrimaryKey;
			};

			deployment = project['deployment'];
			deploymentProject = project['id'];
		}

		const id = randomUUID();

		await super.createOne({
			id,
			deployment,
			deployment_project: deploymentProject,
			deployment_run: deploymentRun,
			status: 'pending',
			attempts: 0,
			requested_snapshot: JSON.stringify(input.snapshot),
			requested_permissions: input.permissions ? JSON.stringify(input.permissions) : null,
			result: null,
			error: null,
			expires_at: null,
			started_at: null,
			completed_at: null,
			date_updated: new Date().toISOString(),
		} as unknown as Partial<DeploymentImpactReport>);

		this.processReport(id).catch((error) => {
			useLogger().error(`Failed to process deployment impact report ${id}: ${error}`);
		});

		return this.readOne(id);
	}

	async retry(key: PrimaryKey): Promise<DeploymentImpactReport> {
		if (!this.accountability?.admin) throw new ForbiddenError();

		const existing = (await super.readOne(key)) as ImpactReportRecord;

		if (!['failed', 'expired'].includes(existing.status)) {
			throw new InvalidPayloadError({ reason: `Reports with status "${existing.status}" cannot be retried` });
		}

		await this.updateStatus(key, {
			status: 'pending',
			error: null,
			started_at: null,
			completed_at: null,
			expires_at: null,
		});

		this.processReport(key).catch((error) => {
			useLogger().error(`Failed to process deployment impact report ${key}: ${error}`);
		});

		return this.readOne(key);
	}

	async resume(key: PrimaryKey): Promise<void> {
		await this.knex('directus_deployment_impact_reports')
			.where({ id: key })
			.update({ status: 'pending', attempts: 0, started_at: null, date_updated: new Date().toISOString() });

		this.processReport(key).catch((error) => {
			useLogger().error(`Failed to process deployment impact report ${key}: ${error}`);
		});
	}

	/**
	 * Attach an existing report to the deployment run that was started after reviewing it.
	 */
	async associateWithRun(reportId: PrimaryKey, run: { id: PrimaryKey; project: string }): Promise<void> {
		const report = await this.knex('directus_deployment_impact_reports')
			.select('id', 'deployment', 'deployment_project', 'deployment_run')
			.where({ id: reportId })
			.first();

		if (!report) throw new InvalidPayloadError({ reason: 'Deployment impact report was not found' });

		const projectsService = new ItemsService('directus_deployment_projects', {
			knex: this.knex,
			schema: this.schema,
			accountability: null,
		});

		const project = (await projectsService.readOne(run.project)) as { id: PrimaryKey; deployment: PrimaryKey };

		if (report['deployment_project'] && report['deployment_project'] !== run.project) {
			throw new ForbiddenError();
		}

		await this.knex('directus_deployment_impact_reports')
			.where({ id: reportId })
			.update({
				deployment: project['deployment'],
				deployment_project: project['id'],
				deployment_run: run.id,
				date_updated: new Date().toISOString(),
			});
	}

	private async processReport(key: PrimaryKey): Promise<void> {
		const report = (await this.knex('directus_deployment_impact_reports')
			.where({ id: key })
			.first()) as ImpactReportRecord | undefined;

		if (!report) throw new InvalidPayloadError({ reason: 'Deployment impact report was not found' });

		const attempts = Number(report.attempts ?? 0) + 1;

		await this.updateStatus(key, {
			status: 'processing',
			attempts,
			started_at: new Date().toISOString(),
			error: null,
		});

		try {
			const requestedSnapshot = this.parseJson<Snapshot>(report.requested_snapshot);
			if (!requestedSnapshot) throw new InvalidPayloadError({ reason: 'Stored schema snapshot is invalid' });

			const currentSnapshot = await getSnapshot({ database: this.knex });
			const diff = getSnapshotDiff(currentSnapshot, requestedSnapshot, { mode: 'mirror' });

			const isEmpty =
				diff.collections.length === 0 &&
				diff.fields.length === 0 &&
				diff.relations.length === 0 &&
				(diff.systemFields?.length ?? 0) === 0;

			const targetSensitiveFields = new Set([
				...this.getSensitiveFields(requestedSnapshot),
				...this.getSensitiveFields(currentSnapshot),
			]);

			const affectedCollections = this.getAffectedCollections(diff);

			const readableCollections = this.accountability?.admin
				? new Set(affectedCollections.map((item) => item.collection))
				: await this.getReadableCollections(affectedCollections.map((item) => item.collection));

			const stats = await this.getCollectionStats(affectedCollections, targetSensitiveFields, readableCollections);
			const pendingMigrations = await this.getPendingMigrations();
			const requestedPermissions = this.parseJson<Permission[]>(report.requested_permissions) ?? [];
			const currentPermissions = await this.knex('directus_permissions').select('*');
			const permissionChanges = this.getPermissionChanges(requestedPermissions, currentPermissions as Permission[]);

			const result: DeploymentImpactReportResult = {
				summary: {
					collections: diff.collections.length,
					fields: diff.fields.length,
					relations: diff.relations.length,
					permissions: permissionChanges.length,
					pending_migrations: pendingMigrations.length,
					affected_records: stats.reduce((total, item) => total + (item.record_count ?? 0), 0),
					sensitive_fields: targetSensitiveFields.size,
				},
				collections: stats,
				fields: this.getFieldChanges(diff, targetSensitiveFields),
				permissions: permissionChanges,
				pending_migrations: pendingMigrations,
				diff,
			};

			const env = useEnv();
			const ttl = getMilliseconds(env['DEPLOYMENT_IMPACT_REPORT_TTL']) || 24 * 60 * 60 * 1000;

			await this.updateStatus(key, {
				status: 'completed',
				result: JSON.stringify({ ...result, has_changes: !isEmpty }),
				error: null,
				completed_at: new Date().toISOString(),
				expires_at: new Date(Date.now() + ttl).toISOString(),
			});
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			const shouldRetry = attempts < MAX_ATTEMPTS;

			await this.updateStatus(key, {
				status: shouldRetry ? 'pending' : 'failed',
				error: message,
				completed_at: shouldRetry ? null : new Date().toISOString(),
			});

			if (shouldRetry) {
				setTimeout(() => {
					this.processReport(key).catch((retryError) => {
						useLogger().error(`Failed to process deployment impact report ${key}: ${retryError}`);
					});
				}, 1000 * attempts);
			}
		}
	}

	private async updateStatus(key: PrimaryKey, data: Partial<ImpactReportRecord>): Promise<void> {
		await this.knex('directus_deployment_impact_reports')
			.where({ id: key })
			.update({
				...data,
				date_updated: new Date().toISOString(),
			});
	}

	private async getCollectionStats(
		collections: Array<{ collection: string; action: 'create' | 'update' | 'delete' }>,
		sensitiveFields: Set<string>,
		readableCollections: Set<string>,
	): Promise<DeploymentImpactReportResult['collections']> {
		return Promise.all(
			collections.map(async ({ collection, action }) => {
				const entry: DeploymentImpactReportResult['collections'][number] = {
					collection,
					action,
					accessible: false,
				};

				if (action !== 'create' && readableCollections.has(collection)) {
					try {
						const aggregate = await this.knex(collection).count<{ count: number | string }[]>({ count: '*' });
						entry.record_count = Number(aggregate[0]?.['count'] ?? 0);
						entry.accessible = true;
					} catch {
						entry.accessible = false;
					}
				}

				const fields = [...sensitiveFields]
					.filter((key) => key.startsWith(`${collection}.`))
					.map((key) => key.split('.')[1]!);

				if (fields.length > 0) entry.sensitive_fields = fields;

				return entry;
			}),
		);
	}

	private getAffectedCollections(
		diff: SnapshotDiff,
	): Array<{ collection: string; action: 'create' | 'update' | 'delete' }> {
		const byCollection = new Map<string, 'create' | 'update' | 'delete'>();

		for (const item of diff.collections) {
			byCollection.set(item.collection, item.diff[0]?.kind === DiffKind.DELETE ? 'delete' : 'create');
		}

		for (const item of [...diff.fields, ...diff.relations, ...(diff.systemFields ?? [])]) {
			if (!byCollection.has(item.collection)) byCollection.set(item.collection, 'update');
		}

		return [...byCollection.entries()].map(([collection, action]) => ({ collection, action }));
	}

	private getSensitiveFields(snapshot: Snapshot): Set<string> {
		const sensitive = new Set<string>();

		for (const field of snapshot.fields) {
			const specials = field.meta?.special ?? [];

			const isSensitive =
				field.type === 'hash' ||
				specials.some((special) => special === 'hash' || special === 'conceal' || special.startsWith('encrypt'));

			if (isSensitive) sensitive.add(`${field.collection}.${field.field}`);
		}

		return sensitive;
	}

	private getFieldChanges(
		diff: SnapshotDiff,
		sensitiveFields: Set<string>,
	): DeploymentImpactReportResult['fields'] {
		return diff.fields.map((item) => {
			let action: 'create' | 'update' | 'delete' = 'update';

			if (item.diff[0]?.kind === DiffKind.DELETE) action = 'delete';
			else if (item.diff.some((difference) => difference.kind === DiffKind.NEW)) action = 'create';

			return {
				collection: item.collection,
				field: item.field,
				action,
				sensitive: sensitiveFields.has(`${item.collection}.${item.field}`),
			};
		});
	}

	private getPermissionChanges(
		requestedPermissions: Permission[],
		currentPermissions: Permission[],
	): DeploymentImpactPermissionChange[] {
		const changes: DeploymentImpactPermissionChange[] = [];
		const currentByKey = new Map(currentPermissions.map((permission) => [this.getPermissionKey(permission), permission]));

		for (const permission of requestedPermissions.slice(0, 200)) {
			const current = currentByKey.get(this.getPermissionKey(permission));

			const change: DeploymentImpactPermissionChange = {
				collection: permission.collection,
				action: String(permission.action),
				change: current ? 'updated' : 'added',
			};

			if (Array.isArray(permission.fields)) change.fields = permission.fields;
			changes.push(change);
		}

		const requestedKeys = new Set(requestedPermissions.map((permission) => this.getPermissionKey(permission)));

		for (const permission of currentPermissions) {
			if (!requestedKeys.has(this.getPermissionKey(permission))) {
				changes.push({
					collection: permission.collection,
					action: String(permission.action),
					change: 'removed',
					...(Array.isArray(permission.fields) ? { fields: permission.fields } : {}),
				});
			}
		}

		return changes.slice(0, 200);
	}

	private getPermissionKey(permission: Permission): string {
		return [permission.policy ?? 'public', permission.collection, permission.action].join(':');
	}

	private async getPendingMigrations(): Promise<DeploymentImpactReportResult['pending_migrations']> {
		const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../database/migrations');

		const migrationFiles = (await readdir(migrationsDirectory)).filter((file) =>
			/^[0-9]+[A-Z]-[^.]+\.(?:js|ts)$/.test(file),
		);

		const completed = await this.knex.select<{ version: string; name: string }[]>('*').from('directus_migrations');
		const completedVersions = new Set(completed.map((migration) => migration.version));
		const completedNames = new Map(completed.map((migration) => [migration.version, migration.name]));

		return migrationFiles
			.map((file) => {
				const version = file.split('-')[0]!;

				const name = file
					.split('-')
					.slice(1)
					.join('_')
					.replace(/\.(js|ts)$/, '');

				return { version, name: completedNames.get(version) ?? name };
			})
			.filter((migration) => !completedVersions.has(migration.version))
			.sort((a, b) => a.version.localeCompare(b.version));
	}

	private async markExpiredReports(): Promise<void> {
		await this.knex('directus_deployment_impact_reports')
			.update({ status: 'expired', date_updated: new Date().toISOString() })
			.where({ status: 'completed' })
			.andWhere('expires_at', '<', new Date().toISOString());
	}

	private async serialize(report: ImpactReportRecord): Promise<DeploymentImpactReport> {
		const canReadSensitiveDetails = this.accountability?.admin === true;
		const result = this.parseJson<DeploymentImpactReportResult & { has_changes?: boolean }>(report.result);

		let sanitizedResult: DeploymentImpactReportResult | null = null;

		if (result) {
			if (canReadSensitiveDetails) {
				sanitizedResult = result;
			} else {
				const allowedCollections = await this.getReadableCollections(
					result.collections.map((item) => item.collection),
				);

				sanitizedResult = {
					summary: {
						collections: result.summary.collections,
						fields: result.summary.fields,
						relations: result.summary.relations,
						permissions: 0,
						pending_migrations: 0,
					},
					collections: result.collections
						.filter((item) => allowedCollections.has(item.collection))
						.map(({ collection, action, accessible, record_count }) => ({
							collection,
							action,
							accessible,
							...(record_count !== undefined ? { record_count } : {}),
						})),
					fields: result.fields
						.filter((field) => !field.sensitive && allowedCollections.has(field.collection))
						.map(({ collection, field, action }) => ({ collection, field, action })),
					permissions: [],
					pending_migrations: [],
				};
			}
		}

		return {
			...report,
			requested_snapshot: canReadSensitiveDetails ? this.parseJson<Snapshot>(report.requested_snapshot) : null,
			requested_permissions: canReadSensitiveDetails
				? this.parseJson<Permission[]>(report.requested_permissions)
				: null,
			result: sanitizedResult,
		};
	}

	private async getReadableCollections(collections: string[]): Promise<Set<string>> {
		const allowed = new Set<string>();

		await Promise.all(
			collections.map(async (collection) => {
				try {
					const service = new ItemsService(collection, {
						knex: this.knex,
						schema: this.schema,
						accountability: this.accountability,
					});

					await service.readByQuery({ aggregate: { count: ['*'] }, limit: 1 });
					allowed.add(collection);
				} catch {
					// User cannot read this collection; record counts and field names must not be returned.
				}
			}),
		);

		return allowed;
	}

	private parseJson<T>(value: unknown): T | null {
		if (value === null || value === undefined) return null;
		if (typeof value !== 'string') return value as T;

		try {
			return JSON.parse(value) as T;
		} catch {
			return null;
		}
	}
}
