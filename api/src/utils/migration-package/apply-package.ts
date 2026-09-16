import type { SchemaOverview, Snapshot, SnapshotDiff, SnapshotField, SnapshotRelation } from '@directus/types';
import { DiffKind } from '@directus/types';
import deepDiff from 'deep-diff';
import type { Knex } from 'knex';
import { flushCaches } from '../../cache.js';
import getDatabase from '../../database/index.js';
import { useLogger } from '../../logger/index.js';
import { getSchema } from '../get-schema.js';
import { getVersionedHash } from '../get-versioned-hash.js';
import { applyDiff } from '../schema/apply-diff.js';
import { getSnapshot } from '../schema/get-snapshot.js';
import { ensurePackageStepsTable, getPackageRecords, recordStepCompleted, recordStepFailed } from './bookkeeping.js';
import { checkMigrationPackage, type CompatibilityResult } from './check-package.js';
import type { MigrationPackage } from './types.js';
import { validateMigrationPackage } from './validate-package.js';

export interface ApplyMigrationPackageOptions {
	database?: Knex | undefined;
	/** Bypass the source/target hash mismatch warning (structural conflicts still fail). */
	allowHashMismatch?: boolean | undefined;
	/** Called before each step is applied. */
	onStepStart?: (info: { index: number; total: number; stepId: string; name: string }) => void;
	/** Called after each committed step. */
	onStepComplete?: (info: { index: number; total: number; stepId: string; name: string }) => void;
}

export class MigrationPackageApplyError extends Error {
	constructor(
		public readonly packageId: string,
		public readonly stepId: string,
		cause: unknown,
	) {
		super(
			`Step "${stepId}" of migration package "${packageId}" failed: ${
				cause instanceof Error ? cause.message : String(cause)
			}. The transaction was rolled back; completed steps remain applied and the run is resumable.`,
		);

		this.name = 'MigrationPackageApplyError';
	}
}

export interface MigrationPackagePlan {
	package: MigrationPackage;
	compatibility: CompatibilityResult;
	currentSnapshot: Snapshot;
}

/**
 * Runs all read-only pre-flight work: format validation, bookkeeping lookup and
 * the compatibility check against the current schema. Returns the resolved
 * plan; throws on hard conflicts.
 */
export async function planMigrationPackage(
	pkg: unknown,
	options?: {
		database?: Knex | undefined;
		allowHashMismatch?: boolean | undefined;
		/** When false (check / dry-run), the bookkeeping table is never created. */
		ensureTable?: boolean | undefined;
	},
): Promise<MigrationPackagePlan> {
	validateMigrationPackage(pkg);

	const database = options?.database ?? getDatabase();

	if (options?.ensureTable !== false) {
		await ensurePackageStepsTable(database);
	}

	const currentSnapshot = await getSnapshot({ database });

	const records = await getPackageRecords(database, pkg.id, {
		ensureTable: options?.ensureTable !== false,
	});

	const compatibility = checkMigrationPackage(pkg, currentSnapshot, records, {
		allowHashMismatch: options?.allowHashMismatch,
		currentHash: getVersionedHash(currentSnapshot),
	});

	return { package: pkg, compatibility, currentSnapshot };
}

/**
 * Applies a migration package step by step.
 *
 * Each step runs in its own database transaction together with its bookkeeping
 * insert, so a failed step rolls back cleanly while previously completed steps
 * stay committed. Completed steps are skipped on re-runs, making the process
 * idempotent and resumable.
 */
export async function applyMigrationPackage(
	pkg: unknown,
	options?: ApplyMigrationPackageOptions,
): Promise<{ applied: string[]; skipped: string[] }> {
	const logger = useLogger();
	const database = options?.database ?? getDatabase();

	const plan = await planMigrationPackage(pkg, {
		database,
		allowHashMismatch: options?.allowHashMismatch,
	});

	const { compatibility, currentSnapshot } = plan;
	const validatedPackage = pkg as MigrationPackage;
	const completedSet = new Set(compatibility.completed);

	const total = validatedPackage.steps.length;
	const applied: string[] = [];
	const skipped: string[] = [];

	for (const [index, step] of validatedPackage.steps.entries()) {
		if (completedSet.has(step.id)) {
			skipped.push(step.id);
			continue;
		}

		options?.onStepStart?.({ index: index + 1, total, stepId: step.id, name: step.name });

		// Re-read the schema for every step so services operate on current state
		const schema: SchemaOverview = await getSchema({ database, bypassCache: true });

		try {
			// The schema diff for this step is applied against the live schema;
			// applyDiff reuses the passed transaction when one is given.
			await database.transaction(async (trx) => {
				await applyDiff(currentSnapshot, step.diff, { database: trx, schema });
				await recordStepCompleted(trx, validatedPackage.id, step.id);
			});
		} catch (error) {
			// The step transaction has been rolled back at this point. Persist the
			// failure marker in a separate transaction so the package is left in a
			// known, resumable state.
			try {
				await recordStepFailed(database, validatedPackage.id, step.id, error);
			} catch (recordError) {
				logger.error(`Failed to record failure of step "${step.id}": ${String(recordError)}`);
			}

			logger.error(
				`Step ${index + 1}/${total} "${step.name}" failed. ` +
					`${applied.length} step(s) from this run were already committed. ` +
					`Fix the issue and re-run to resume from "${step.id}".`,
			);

			await flushCaches();

			throw new MigrationPackageApplyError(validatedPackage.id, step.id, error);
		}

		// Update the in-memory baseline so later steps (e.g. creating a nested
		// collection under a group created by an earlier step) see prior changes.
		updateBaseline(currentSnapshot, step.diff);

		applied.push(step.id);
		options?.onStepComplete?.({ index: index + 1, total, stepId: step.id, name: step.name });
	}

	await flushCaches();

	return { applied, skipped };
}

/** Replays a committed step's diff onto the in-memory baseline snapshot. */
function updateBaseline(baseline: Snapshot, diff: SnapshotDiff): void {
	for (const { collection, diff: changes } of diff.collections) {
		const index = baseline.collections.findIndex((entry) => entry.collection === collection);

		if (changes[0]?.kind === DiffKind.NEW) {
			baseline.collections.push(changes[0].rhs as Snapshot['collections'][number]);
		} else if (changes[0]?.kind === DiffKind.DELETE) {
			baseline.collections.splice(index, 1);
		} else if (index !== -1) {
			for (const change of changes) deepDiff.applyChange(baseline.collections[index]!, undefined, change);
		}
	}

	for (const { collection, field, diff: changes } of diff.fields) {
		const index = baseline.fields.findIndex((entry) => entry.collection === collection && entry.field === field);

		if (changes[0]?.kind === DiffKind.NEW && changes[0].path?.[0] !== 'meta') {
			baseline.fields.push(changes[0].rhs as SnapshotField);
		} else if (changes[0]?.kind === DiffKind.DELETE && changes[0].path?.[0] !== 'meta' && index !== -1) {
			baseline.fields.splice(index, 1);
		} else if (index !== -1) {
			for (const change of changes) deepDiff.applyChange(baseline.fields[index]!, undefined, change);
		}
	}

	for (const { collection, field, diff: changes } of diff.relations) {
		const index = baseline.relations.findIndex((entry) => entry.collection === collection && entry.field === field);

		if (changes[0]?.kind === DiffKind.NEW) {
			baseline.relations.push(changes[0].rhs as SnapshotRelation);
		} else if (changes[0]?.kind === DiffKind.DELETE) {
			baseline.relations.splice(index, 1);
		} else if (index !== -1) {
			for (const change of changes) deepDiff.applyChange(baseline.relations[index]!, undefined, change);
		}
	}
}
