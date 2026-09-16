import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
import { SchemaBuilder } from '@directus/schema-builder';
import { DiffKind } from '@directus/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockKnex, resetKnexMocks } from '../test-utils/knex.js';
import { DeploymentImpactReportsService } from './deployment-impact-reports.js';
import { ItemsService } from './items.js';

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		readdir: vi.fn(async () => ['20990101A-future-migration.js']),
	};
});

vi.mock('../database/index.js', async () => {
	const { mockDatabase } = await import('../test-utils/database.js');
	return mockDatabase();
});

vi.mock('../utils/schema/get-snapshot.js', () => ({
	getSnapshot: vi.fn(),
}));

vi.mock('../utils/schema/get-snapshot-diff.js', () => ({
	getSnapshotDiff: vi.fn(),
}));

vi.mock('@directus/env', () => ({
	useEnv: vi.fn(() => ({ DEPLOYMENT_IMPACT_REPORT_TTL: '1h' })),
}));

vi.mock('../logger/index.js', () => ({
	useLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

const { getSnapshot } = await import('../utils/schema/get-snapshot.js');
const { getSnapshotDiff } = await import('../utils/schema/get-snapshot-diff.js');

const schema = new SchemaBuilder()
	.collection('directus_deployment_impact_reports', (c) => {
		c.field('id').uuid().primary();
	})
	.collection('articles', (c) => {
		c.field('id').integer().primary();
	})
	.collection('secret_things', (c) => {
		c.field('id').integer().primary();
	})
	.build();

const validSnapshot = {
	version: 1,
	directus: 'test',
	vendor: 'sqlite',
	collections: [],
	fields: [],
	systemFields: [],
	relations: [],
};

function makeReport(overrides = {}) {
	return {
		id: 'report-1',
		deployment: null,
		deployment_run: null,
		status: 'completed',
		attempts: 1,
		requested_snapshot: JSON.stringify(validSnapshot),
		requested_permissions: null,
		result: JSON.stringify({
			summary: {
				collections: 2,
				fields: 2,
				relations: 0,
				permissions: 0,
				pending_migrations: 1,
				affected_records: 7,
				sensitive_fields: 1,
			},
			collections: [
				{ collection: 'articles', action: 'update', accessible: true, record_count: 7 },
				{
					collection: 'secret_things',
					action: 'update',
					accessible: true,
					record_count: 3,
					sensitive_fields: ['password'],
				},
			],
			fields: [
				{ collection: 'articles', field: 'title', action: 'update' },
				{ collection: 'secret_things', field: 'password', action: 'update', sensitive: true },
			],
			permissions: [],
			pending_migrations: [{ version: '20990101A', name: 'Future Migration' }],
			diff: {},
		}),
		error: null,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		started_at: null,
		completed_at: new Date().toISOString(),
		date_created: new Date().toISOString(),
		date_updated: new Date().toISOString(),
		...overrides,
	};
}

describe('DeploymentImpactReportsService', () => {
	const { db, tracker, mockSchemaBuilder } = createMockKnex();
	let superCreateOne: any;
	let superReadOne: any;

	beforeEach(() => {
		resetKnexMocks(tracker, mockSchemaBuilder);
		vi.mocked(getSnapshot).mockResolvedValue(validSnapshot as any);

		vi.mocked(getSnapshotDiff).mockResolvedValue({
			collections: [],
			fields: [
				{
					collection: 'articles',
					field: 'title',
					diff: [{ kind: DiffKind.NEW, path: ['meta'], rhs: {} }],
				},
				{
					collection: 'articles',
					field: 'body',
					diff: [{ kind: DiffKind.EDIT, path: ['schema', 'is_nullable'], lhs: false, rhs: true }],
				},
			],
			systemFields: [],
			relations: [],
		} as any);

		tracker.on.select('directus_migrations').response([]);
		tracker.on.select('directus_permissions').response([]);
		tracker.on.select('articles').response([{ count: 7 }]);

		tracker.on
			.select('directus_deployment_impact_reports')
			.response([makeReport({ status: 'pending', attempts: 0, result: null, completed_at: null, expires_at: null })]);

		tracker.on.update('directus_deployment_impact_reports').response([]);

		superCreateOne = vi.spyOn(ItemsService.prototype, 'createOne').mockResolvedValue('report-1');
		superReadOne = vi.spyOn(ItemsService.prototype, 'readOne').mockResolvedValue(makeReport());

		vi.spyOn(ItemsService.prototype, 'readByQuery')
			.mockClear()
			.mockImplementation(async function (this: ItemsService<any>) {
				if (this.collection === 'articles' || this.collection === 'directus_deployments') return [{ count: 0 }] as any;
				throw new ForbiddenError();
			});
	});

	it('forbids report creation for non-administrators', async () => {
		const service = new DeploymentImpactReportsService({ knex: db, schema, accountability: { admin: false } as any });

		await expect(service.createReport({ snapshot: validSnapshot as any })).rejects.toBeInstanceOf(ForbiddenError);
		expect(superCreateOne).not.toHaveBeenCalled();
	});

	it('validates that a snapshot is supplied', async () => {
		const service = new DeploymentImpactReportsService({ knex: db, schema, accountability: { admin: true } as any });

		await expect(service.createReport({ snapshot: undefined as any })).rejects.toBeInstanceOf(InvalidPayloadError);
	});

	it('creates an asynchronous report and summarizes diff, content and migrations', async () => {
		const service = new DeploymentImpactReportsService({ knex: db, schema, accountability: { admin: true } as any });

		const report = await service.createReport({ snapshot: validSnapshot as any });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(superCreateOne).toHaveBeenCalledWith(
			expect.objectContaining({ id: expect.any(String), status: 'pending', requested_permissions: null }),
		);

		expect(report.status).toBe('completed');
		expect(report.result?.summary.fields).toBe(2);
		expect(report.result?.summary.affected_records).toBe(7);
		expect(report.result?.summary.pending_migrations).toBe(1);
	});

	it('hides record counts and sensitive fields from non-administrators without collection access', async () => {
		const service = new DeploymentImpactReportsService({ knex: db, schema, accountability: { admin: false } as any });
		const report = await service.readOne('report-1');

		expect(report.requested_snapshot).toBeNull();
		expect(report.requested_permissions).toBeNull();

		expect(report.result?.collections).toEqual([
			{ collection: 'articles', action: 'update', accessible: true, record_count: 7 },
		]);

		expect(report.result?.fields).toEqual([{ collection: 'articles', field: 'title', action: 'update' }]);
		expect(report.result?.summary.affected_records).toBeUndefined();
		expect(report.result?.summary.sensitive_fields).toBeUndefined();
	});

	it('only retries failed or expired reports', async () => {
		superReadOne.mockResolvedValueOnce(makeReport({ status: 'completed' }));
		const service = new DeploymentImpactReportsService({ knex: db, schema, accountability: { admin: true } as any });

		await expect(service.retry('report-1')).rejects.toBeInstanceOf(InvalidPayloadError);
	});
});
