import type { Knex } from 'knex';
import { MIGRATION_PACKAGE_STEPS_TABLE, type MigrationPackageStepRecord } from './types.js';

/**
 * Ensures the bookkeeping table recording package step progress exists.
 *
 * The table is created lazily (rather than through the core migration flow) so
 * that migration packages work on any already-bootstrapped instance without a
 * versioned schema migration. It is created once per connection and cached.
 */
const ensured = new WeakSet<Knex>();

export async function ensurePackageStepsTable(database: Knex): Promise<void> {
	if (ensured.has(database)) return;

	const hasTable = await database.schema.hasTable(MIGRATION_PACKAGE_STEPS_TABLE);

	if (!hasTable) {
		await database.schema.createTable(MIGRATION_PACKAGE_STEPS_TABLE, (table) => {
			table.string('package', 255).notNullable();
			table.string('step', 255).notNullable();
			table.string('status', 16).notNullable();
			table.text('error').nullable();
			table.timestamp('timestamp').notNullable().defaultTo(database.fn.now());
			table.primary(['package', 'step']);
		});
	}

	ensured.add(database);
}

export async function getPackageRecords(
	database: Knex,
	packageId: string,
	options?: { ensureTable?: boolean | undefined },
): Promise<MigrationPackageStepRecord[]> {
	const ensureTable = options?.ensureTable ?? true;

	if (ensureTable) {
		await ensurePackageStepsTable(database);
	} else if (!(await database.schema.hasTable(MIGRATION_PACKAGE_STEPS_TABLE))) {
		// Read-only runs (check / dry-run) must not create the table.
		return [];
	}

	return database
		.select<MigrationPackageStepRecord[]>('*')
		.from(MIGRATION_PACKAGE_STEPS_TABLE)
		.where({ package: packageId })
		.orderBy('step');
}

/**
 * Portable upsert of a bookkeeping row: update in place when present (e.g. a
 * previous failure being retried), otherwise insert. Always executed inside the
 * caller's transaction so the marker shares the step's transaction boundary.
 */
async function upsertStepRecord(
	executor: Knex,
	packageId: string,
	stepId: string,
	values: { status: 'completed' | 'failed'; error: string | null },
): Promise<void> {
	const existing = await executor(MIGRATION_PACKAGE_STEPS_TABLE)
		.select('step')
		.where({ package: packageId, step: stepId })
		.first();

	if (existing) {
		await executor(MIGRATION_PACKAGE_STEPS_TABLE)
			.where({ package: packageId, step: stepId })
			.update({ ...values, timestamp: executor.fn.now() });
	} else {
		await executor(MIGRATION_PACKAGE_STEPS_TABLE).insert({ package: packageId, step: stepId, ...values });
	}
}

/** Marks a step completed within the given transaction. */
export async function recordStepCompleted(trx: Knex, packageId: string, stepId: string): Promise<void> {
	await upsertStepRecord(trx, packageId, stepId, { status: 'completed', error: null });
}

/**
 * Records a failed step. This deliberately happens *outside* the failed step's
 * transaction (which is being rolled back) and inside a fresh one so the
 * failure marker survives.
 */
export async function recordStepFailed(
	database: Knex,
	packageId: string,
	stepId: string,
	error: unknown,
): Promise<void> {
	const message = (error instanceof Error ? error.message : String(error)).slice(0, 10000);

	await database.transaction(async (trx) => {
		await upsertStepRecord(trx, packageId, stepId, { status: 'failed', error: message });
	});
}
