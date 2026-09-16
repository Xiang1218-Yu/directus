import { DiffKind } from '@directus/types';
import type { Knex } from 'knex';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getSchema } from '../get-schema.js';
import { applyDiff } from '../schema/apply-diff.js';
import { getSnapshot } from '../schema/get-snapshot.js';
import { applyMigrationPackage, MigrationPackageApplyError, planMigrationPackage } from './apply-package.js';
import { ensurePackageStepsTable, getPackageRecords, recordStepCompleted, recordStepFailed } from './bookkeeping.js';
import { buildMigrationPackage } from './build-package.js';

vi.mock('../schema/get-snapshot.js', () => ({
	getSnapshot: vi.fn(() =>
		Promise.resolve({
			version: 1,
			directus: '11.0.0',
			collections: [],
			fields: [],
			systemFields: [],
			relations: [],
		}),
	),
}));

vi.mock('../schema/apply-diff.js');
vi.mock('../get-schema.js');
vi.mock('../../cache.js', () => ({ flushCaches: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./bookkeeping.js');

const createDiff = (collections: string[]) => ({
	collections: collections.map((collection) => ({
		collection,
		diff: [{ kind: DiffKind.NEW, rhs: { collection, meta: {}, schema: {} } }],
	})),
	fields: [],
	systemFields: [],
	relations: [],
});

function emptyCurrentSnapshot() {
	return {
		version: 1,
		directus: '11.0.0',
		collections: [],
		fields: [],
		systemFields: [],
		relations: [],
	};
}

describe('applyMigrationPackage', () => {
	let database: any;
	let trx: any;

	beforeEach(() => {
		vi.clearAllMocks();

		trx = {};

		database = {
			fn: { now: () => 'NOW()' },
			transaction: vi.fn((handler: (trx: any) => Promise<void>) => handler(trx)),
		};

		vi.mocked(ensurePackageStepsTable).mockResolvedValue(undefined);
		vi.mocked(getSchema).mockResolvedValue({} as any);
		vi.mocked(getSnapshot).mockResolvedValue(emptyCurrentSnapshot() as any);
		vi.mocked(applyDiff).mockResolvedValue(undefined);
		vi.mocked(getPackageRecords).mockResolvedValue([]);
		vi.mocked(recordStepCompleted).mockResolvedValue(undefined);
		vi.mocked(recordStepFailed).mockResolvedValue(undefined);
	});

	test('applies every step in its own transaction and records completion', async () => {
		const pkg = buildMigrationPackage(createDiff(['a', 'b']) as any, { id: 'pkg-1' });

		expect(pkg.steps).toHaveLength(2);

		const result = await applyMigrationPackage(pkg, { database: database as unknown as Knex });

		expect(result.applied).toEqual(pkg.steps.map((step) => step.id));
		expect(database.transaction).toHaveBeenCalledTimes(2);
		expect(applyDiff).toHaveBeenCalledTimes(2);

		for (const step of pkg.steps) {
			expect(recordStepCompleted).toHaveBeenCalledWith(trx, 'pkg-1', step.id);
		}
	});

	test('skips steps recorded as completed without opening a transaction', async () => {
		const pkg = buildMigrationPackage(createDiff(['a', 'b']) as any, { id: 'pkg-1' });

		vi.mocked(getPackageRecords).mockResolvedValue([
			{ package: 'pkg-1', step: pkg.steps[0]!.id, status: 'completed', error: null, timestamp: new Date() },
		]);

		const result = await applyMigrationPackage(pkg, { database: database as unknown as Knex });

		expect(result.skipped).toEqual([pkg.steps[0]!.id]);
		expect(result.applied).toEqual([pkg.steps[1]!.id]);
		expect(database.transaction).toHaveBeenCalledTimes(1);
		expect(applyDiff).toHaveBeenCalledTimes(1);
	});

	test('a failing step is recorded outside its transaction and the run stops resumably', async () => {
		const pkg = buildMigrationPackage(createDiff(['a', 'b']) as any, { id: 'pkg-1' });

		vi.mocked(applyDiff).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('boom'));

		await expect(applyMigrationPackage(pkg, { database: database as unknown as Knex })).rejects.toBeInstanceOf(
			MigrationPackageApplyError,
		);

		// Second step's transaction failed; no later step ran
		expect(applyDiff).toHaveBeenCalledTimes(2);
		expect(recordStepCompleted).toHaveBeenCalledTimes(1);
		expect(recordStepCompleted).toHaveBeenCalledWith(trx, 'pkg-1', pkg.steps[0]!.id);

		// The failure marker is written in its own (outer) transaction, not the rolled-back one
		expect(recordStepFailed).toHaveBeenCalledTimes(1);
		expect(recordStepFailed).toHaveBeenCalledWith(database, 'pkg-1', pkg.steps[1]!.id, expect.any(Error));
	});

	test('planMigrationPackage validates the package before touching the schema', async () => {
		await expect(planMigrationPackage({ kind: 'nope' }, { database: database as unknown as Knex })).rejects.toThrow();

		expect(ensurePackageStepsTable).not.toHaveBeenCalled();
		expect(getSchema).not.toHaveBeenCalled();
	});
});
