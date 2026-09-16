import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import type { Snapshot } from '@directus/types';
import { parseJSON } from '@directus/utils';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { load as loadYaml } from 'js-yaml';
import getDatabase from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { getVersionedHash } from '../../../utils/get-versioned-hash.js';
import { buildMigrationPackage } from '../../../utils/migration-package/build-package.js';
import { serializeMigrationPackage } from '../../../utils/migration-package/io.js';
import { validateMigrationPackage } from '../../../utils/migration-package/validate-package.js';
import { getSnapshotDiff } from '../../../utils/schema/get-snapshot-diff.js';
import { getSnapshot } from '../../../utils/schema/get-snapshot.js';

export interface PackageCreateOptions {
	yes: boolean;
	format: 'json' | 'yaml';
	/** Optional snapshot file to diff from. Defaults to the live instance. */
	from?: string | undefined;
	id?: string | undefined;
	author?: string | undefined;
	description?: string | undefined;
}

export async function readSnapshotFile(filename: string): Promise<Snapshot> {
	const contents = await fs.readFile(filename, 'utf8');

	if (/\.ya?ml$/i.test(filename)) {
		return loadYaml(contents) as Snapshot;
	}

	return parseJSON(contents) as Snapshot;
}

/**
 * Generates a reviewable migration package from the difference between the
 * live instance's snapshot (or a `--from` snapshot file) and a target
 * snapshot file. Nothing is written to the database.
 */
export async function packageCreate(
	targetSnapshotPath: string,
	options: PackageCreateOptions,
	outputPath?: string,
): Promise<void> {
	const logger = useLogger();
	const database = getDatabase();

	try {
		const targetFile = path.resolve(process.cwd(), targetSnapshotPath);
		const toSnapshot = await readSnapshotFile(targetFile);

		let fromSnapshot: Snapshot;

		if (options.from) {
			fromSnapshot = await readSnapshotFile(path.resolve(process.cwd(), options.from));
		} else {
			fromSnapshot = await getSnapshot({ database });
		}

		const fromHash = getVersionedHash(fromSnapshot);
		const toHash = getVersionedHash(toSnapshot);

		const diff = getSnapshotDiff(fromSnapshot, toSnapshot);

		const packageId =
			options.id ?? `schema-${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}`;

		const pkg = buildMigrationPackage(diff, {
			id: packageId,
			from: fromSnapshot,
			to: toSnapshot,
			fromHash,
			toHash,
			metadata: {
				...(options.author ? { author: options.author } : {}),
				...(options.description ? { description: options.description } : {}),
			},
		});

		// Fail fast on an invalid explicit --id or a malformed generated package
		validateMigrationPackage(pkg);

		const serialized = serializeMigrationPackage(pkg, options.format === 'yaml' ? 'yaml' : 'json');

		if (outputPath) {
			const filename = path.resolve(process.cwd(), outputPath);

			let exists = false;

			try {
				await fs.access(filename, fsConstants.F_OK);
				exists = true;
			} catch {
				exists = false;
			}

			if (exists && options.yes === false) {
				const { overwrite } = await inquirer.prompt([
					{
						type: 'confirm',
						name: 'overwrite',
						message: 'Migration package already exists. Do you want to overwrite the file?',
					},
				]);

				if (overwrite === false) {
					database.destroy();
					return process.exit(0);
				}
			}

			await fs.writeFile(filename, serialized);
			logger.info(`Migration package "${packageId}" with ${pkg.steps.length} step(s) saved to ${filename}`);
		} else {
			process.stdout.write(serialized);
		}

		if (pkg.steps.length === 0) {
			logger.info(chalk.yellow('The snapshots are identical: the migration package contains no steps.'));
		}

		database.destroy();
		return process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}
