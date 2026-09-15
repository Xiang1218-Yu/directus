import { promises as fs } from 'fs';
import path from 'path';
import type { Snapshot } from '@directus/types';
import { parseJSON } from '@directus/utils';
import { load as loadYaml } from 'js-yaml';
import type { Knex } from 'knex';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { getSnapshotDiff } from '../../../utils/schema/get-snapshot-diff.js';
import { getSnapshot } from '../../../utils/schema/get-snapshot.js';
import { validateSnapshot } from '../../../utils/schema/validate-snapshot.js';
import { filterSnapshotDiff, formatSnapshotDiffSections, sortSnapshotDiff } from './utils.js';

/**
 * Exit codes used by the diff command, allowing scripts to diagnose the outcome
 */
export const DiffExitCode = {
	NO_DIFFERENCES: 0,
	DIFFERENCES_FOUND: 1,
	FILE_NOT_FOUND: 2,
	INVALID_SNAPSHOT: 3,
	ERROR: 4,
} as const;

export class SnapshotFileNotFoundError extends Error {
	constructor(filename: string) {
		super(`Snapshot file not found: ${filename}`);
		this.name = 'SnapshotFileNotFoundError';
	}
}

export class InvalidSnapshotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidSnapshotError';
	}
}

export interface DiffOptions {
	format?: 'text' | 'json' | undefined;
	ignoreRules?: string | undefined;
}

/**
 * Compare the current database schema against a snapshot file, or two snapshot files against
 * each other, and report the differences.
 *
 * Read-only: never modifies the database and never prompts to apply the changes.
 */
export async function diff(
	snapshotPath: string,
	otherSnapshotPath: string | undefined,
	options?: DiffOptions,
): Promise<void> {
	const logger = useLogger();

	let database: Knex | undefined;

	try {
		const afterSnapshot = await loadSnapshotFile(otherSnapshotPath ?? snapshotPath);

		let currentSnapshot: Snapshot;

		if (otherSnapshotPath === undefined) {
			// Compare the current database schema against the given snapshot file
			database = getDatabase();

			await validateDatabaseConnection(database);

			if ((await isInstalled()) === false) {
				logger.error(`Directus isn't installed on this database. Please run "directus bootstrap" first.`);
				database.destroy();
				process.exit(DiffExitCode.ERROR);
			} else {
				currentSnapshot = await getSnapshot({ database });
			}
		} else {
			// Compare two snapshot files against each other, no database connection required
			currentSnapshot = await loadSnapshotFile(snapshotPath);
		}

		let snapshotDiff = getSnapshotDiff(currentSnapshot, afterSnapshot);

		if (options?.ignoreRules) {
			snapshotDiff = filterSnapshotDiff(snapshotDiff, options.ignoreRules.split(','));
		}

		snapshotDiff = sortSnapshotDiff(snapshotDiff);

		const hasDifferences =
			snapshotDiff.collections.length > 0 ||
			snapshotDiff.fields.length > 0 ||
			snapshotDiff.systemFields.length > 0 ||
			snapshotDiff.relations.length > 0;

		if (options?.format === 'json') {
			process.stdout.write(JSON.stringify(snapshotDiff, null, 2) + '\n');
		} else if (hasDifferences) {
			// eslint-disable-next-line no-console
			console.log('The following differences were found:\n\n' + formatSnapshotDiffSections(snapshotDiff).join('\n\n'));
		} else {
			// eslint-disable-next-line no-console
			console.log('No differences found.');
		}

		database?.destroy();
		process.exit(hasDifferences ? DiffExitCode.DIFFERENCES_FOUND : DiffExitCode.NO_DIFFERENCES);
	} catch (err: any) {
		database?.destroy();

		if (err instanceof SnapshotFileNotFoundError) {
			logger.error(err.message);
			process.exit(DiffExitCode.FILE_NOT_FOUND);
		} else if (err instanceof InvalidSnapshotError) {
			logger.error(err.message);
			process.exit(DiffExitCode.INVALID_SNAPSHOT);
		} else {
			logger.error(err);
			process.exit(DiffExitCode.ERROR);
		}
	}
}

/**
 * Read and validate a JSON or YAML snapshot file
 */
export async function loadSnapshotFile(snapshotPath: string): Promise<Snapshot> {
	const filename = path.resolve(process.cwd(), snapshotPath);

	let fileContents: string;

	try {
		fileContents = await fs.readFile(filename, 'utf8');
	} catch (err: any) {
		if (err?.code === 'ENOENT') {
			throw new SnapshotFileNotFoundError(filename);
		}

		throw err;
	}

	let parsed: unknown;

	try {
		if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
			parsed = loadYaml(fileContents);
		} else {
			parsed = parseJSON(fileContents);
		}
	} catch (err: any) {
		throw new InvalidSnapshotError(`Failed to parse ${filename}: ${err.message}`);
	}

	try {
		// Validate the structure only. Differences in Directus version and vendor are
		// reported as part of the diff instead of being rejected.
		validateSnapshot(parsed as Snapshot, true);
	} catch (err: any) {
		throw new InvalidSnapshotError(`Invalid snapshot ${filename}: ${err.message}`);
	}

	const snapshot = parsed as Snapshot;

	// Snapshots may omit empty groups
	const normalized: Snapshot = {
		version: snapshot.version,
		directus: snapshot.directus,
		collections: snapshot.collections ?? [],
		fields: snapshot.fields ?? [],
		systemFields: snapshot.systemFields ?? [],
		relations: snapshot.relations ?? [],
	};

	if (snapshot.vendor) {
		normalized.vendor = snapshot.vendor;
	}

	return normalized;
}
