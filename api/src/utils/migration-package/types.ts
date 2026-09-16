import type { Snapshot, SnapshotDiff } from '@directus/types';

/**
 * A migration package is a reviewable, replayable artifact describing the
 * transition from one schema snapshot ("from") to another ("to").
 *
 * The diff is split into ordered {@link MigrationPackageStep steps}, each of
 * which is applied in its own database transaction and tracked individually so
 * a failed or interrupted run can be resumed.
 */

export const MIGRATION_PACKAGE_KIND = 'directus.schema-migration-package';
export const MIGRATION_PACKAGE_VERSION = 1;
export const MIGRATION_PACKAGE_STEPS_TABLE = 'directus_schema_migration_steps';

export type MigrationPackageStepKind =
	| 'create-collection'
	| 'update-collection'
	| 'delete-collection'
	| 'create-field'
	| 'update-field'
	| 'delete-field'
	| 'update-system-field'
	| 'create-relation'
	| 'update-relation'
	| 'delete-relation';

export type MigrationPackageStepStatus = 'pending' | 'completed' | 'failed';

/**
 * A single, ordered unit of work. `diff` is a {@link SnapshotDiff} containing
 * only the changes applied by this step and is handed to the existing
 * `applyDiff` infrastructure inside one transaction.
 */
export type MigrationPackageStep = {
	/** Stable id, unique within the package, used for bookkeeping and logs. */
	id: string;
	/** Human readable description shown in plans and logs. */
	name: string;
	kind: MigrationPackageStepKind;
	/** Target collection (and field/relation when applicable). */
	collection: string;
	field?: string | undefined;
	related_collection?: string | null | undefined;
	/** The exact slice of the snapshot diff applied by this step. */
	diff: SnapshotDiff;
};

export type MigrationPackageMetadata = {
	/** ISO timestamp of when the package was generated. */
	createdAt: string;
	/** Optional free-form author / CI actor. */
	author?: string | undefined;
	/** Optional note intended for reviewers. */
	description?: string | undefined;
};

export type MigrationPackage = {
	kind: typeof MIGRATION_PACKAGE_KIND;
	version: typeof MIGRATION_PACKAGE_VERSION;
	/** Package-wide unique identifier, used as the bookkeeping key. */
	id: string;
	metadata: MigrationPackageMetadata;
	/** Snapshot the package was generated against. Kept for review/audit only. */
	from: Pick<Snapshot, 'version' | 'directus' | 'vendor'>;
	/** Desired snapshot. Kept for review/audit only. */
	to: Pick<Snapshot, 'version' | 'directus' | 'vendor'>;
	/** Hash of the "from" snapshot, if it was available. */
	fromHash?: string | undefined;
	/** Hash of the target snapshot, if it was available. */
	toHash?: string | undefined;
	steps: MigrationPackageStep[];
};

/** A row of the {@link MIGRATION_PACKAGE_STEPS_TABLE} bookkeeping table. */
export type MigrationPackageStepRecord = {
	package: string;
	step: string;
	status: Exclude<MigrationPackageStepStatus, 'pending'>;
	error: string | null;
	timestamp: Date;
};

export type CompatibilityIssueLevel = 'error' | 'warning';

export type CompatibilityIssue = {
	level: CompatibilityIssueLevel;
	step?: string | undefined;
	message: string;
};

/** Result of the read-only pre-flight compatibility check. */
export type CompatibilityResult = {
	issues: CompatibilityIssue[];
	/** Ids of steps already recorded as completed in the target database. */
	completed: string[];
	/** Ids of steps still pending (in order). */
	pending: string[];
	/** True when the package was previously recorded as failed mid-run. */
	resumable: boolean;
};
