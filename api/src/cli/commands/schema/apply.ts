import { promises as fs } from 'fs';
import path from 'path';
import type { Snapshot } from '@directus/types';
import { parseJSON } from '@directus/utils';
import inquirer from 'inquirer';
import { load as loadYaml } from 'js-yaml';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { getLicenseManager } from '../../../license/index.js';
import { useLogger } from '../../../logger/index.js';
import { applySnapshot } from '../../../utils/schema/apply-snapshot.js';
import { getSnapshotDiff } from '../../../utils/schema/get-snapshot-diff.js';
import { getSnapshot } from '../../../utils/schema/get-snapshot.js';
import { filterSnapshotDiff, formatSnapshotDiffSections } from './utils.js';

export async function apply(
	snapshotPath: string,
	options?: { yes: boolean; dryRun: boolean; ignoreRules: string },
): Promise<void> {
	const logger = useLogger();

	const filename = path.resolve(process.cwd(), snapshotPath);

	const database = getDatabase();

	await validateDatabaseConnection(database);

	if ((await isInstalled()) === false) {
		logger.error(`Directus isn't installed on this database. Please run "directus bootstrap" first.`);
		database.destroy();
		process.exit(0);
	}

	let snapshot: Snapshot;

	try {
		const fileContents = await fs.readFile(filename, 'utf8');

		if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
			snapshot = (await loadYaml(fileContents)) as Snapshot;
		} else {
			snapshot = parseJSON(fileContents) as Snapshot;
		}

		const currentSnapshot = await getSnapshot({ database });
		let snapshotDiff = getSnapshotDiff(currentSnapshot, snapshot);

		if (options?.ignoreRules) {
			snapshotDiff = filterSnapshotDiff(snapshotDiff, options.ignoreRules.split(','));
		}

		if (
			snapshotDiff.collections.length === 0 &&
			snapshotDiff.fields.length === 0 &&
			snapshotDiff.systemFields.length === 0 &&
			snapshotDiff.relations.length === 0
		) {
			logger.info('No changes to apply.');
			database.destroy();
			process.exit(0);
		}

		const dryRun = options?.dryRun === true;
		const promptForChanges = !dryRun && options?.yes !== true;

		if (dryRun || promptForChanges) {
			const message =
				'The following changes will be applied:\n\n' + formatSnapshotDiffSections(snapshotDiff).join('\n\n');

			if (dryRun) {
				// eslint-disable-next-line no-console
				console.log(message);
				process.exit(0);
			}

			const { proceed } = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'proceed',
					message: message + '\n\n' + 'Would you like to continue?',
				},
			]);

			if (proceed === false) {
				process.exit(0);
			}
		}

		// Load the license so schema changes are checked against the active limits
		await getLicenseManager().initialize();

		await applySnapshot(snapshot, { current: currentSnapshot, diff: snapshotDiff, database });

		logger.info(`Snapshot applied successfully`);

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}
