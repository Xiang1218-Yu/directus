import type { Knex } from 'knex';
import {
	MIGRATION_PACKAGE_STEPS_TABLE,
	type MigrationPackageDirection,
	type MigrationPackageStepRecord,
} from './types.js';

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
		await createTable(database);
	} else {
		const hasDirection = await database.schema.hasColumn(MIGRATION_PACKAGE_STEPS_TABLE, 'direction');

		// The direction column was introduced together with package rollback.
		// The bookkeeping table itself is an unreleased feature, so a table left
		// over from earlier builds is rebuilt rather than migrated.
		if (!hasDirection) {
			await database.schema.dropTable(MIGRATION_PACKAGE_STEPS_TABLE);
			await createTable(database);
		}
	}

	ensured.add(database);
}

async function createTable(database: Knex): Promise<void> {
	await database.schema.createTable(MIGRATION_PACKAGE_STEPS_TABLE, (table) => {
		table.string('package', 255).notNullable();
		table.string('direction', 8).notNullable();
		table.string('step', 255).notNullable();
		table.string('status', 16).notNullable();
		table.text('error').nullable();
		table.timestamp('timestamp').notNullable().defaultTo(database.fn.now());
		table.primary(['package', 'direction', 'step']);
	});
}

export async function getPackageRecords(
	database: Knex,
	packageId: string,
	direction: MigrationPackageDirection,
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
		.where({ package: packageId, direction })
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
	direction: MigrationPackageDirection,
	stepId: string,
	values: { status: 'completed' | 'failed'; error: string | null },
): Promise<void> {
	const existing = await executor(MIGRATION_PACKAGE_STEPS_TABLE)
		.select('step')
		.where({ package: packageId, direction, step: stepId })
		.first();

	if (existing) {
		await executor(MIGRATION_PACKAGE_STEPS_TABLE)
			.where({ package: packageId, direction, step: stepId })
			.update({ ...values, timestamp: executor.fn.now() });
	} else {
		await executor(MIGRATION_PACKAGE_STEPS_TABLE).insert({
			package: packageId,
			direction,
			step: stepId,
			...values,
		});
	}
}

/** Marks a step completed within the given transaction. */
export async function recordStepCompleted(
	trx: Knex,
	packageId: string,
	direction: MigrationPackageDirection,
	stepId: string,
): Promise<void> {
	await upsertStepRecord(trx, packageId, direction, stepId, { status: 'completed', error: null });
}

/**
 * Records a failed step. This deliberately happens *outside* the failed step's
 * transaction (which is being rolled back) and inside a fresh one so the
 * failure marker survives.
 */
export async function recordStepFailed(
	database: Knex,
	packageId: string,
	direction: MigrationPackageDirection,
	stepId: string,
	error: unknown,
): Promise<void> {
	const message = (error instanceof Error ? error.message : String(error)).slice(0, 10000);

	await database.transaction(async (trx) => {
		await upsertStepRecord(trx, packageId, direction, stepId, { status: 'failed', error: message });
	});
}

/**
 * Deletes all bookkeeping rows of a package in one direction. Used once a
 * rollback completes fully so the package can be re-applied cleanly.
 */
export async function clearPackageRecords(
	trx: Knex,
	packageId: string,
	direction: MigrationPackageDirection,
): Promise<void> {
	await trx(MIGRATION_PACKAGE_STEPS_TABLE).where({ package: packageId, direction }).del();
}
