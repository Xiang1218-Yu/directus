import path from 'path';
import inquirer from 'inquirer';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { getLicenseManager } from '../../../license/index.js';
import { useLogger } from '../../../logger/index.js';
import { applyMigrationPackage, planMigrationPackage } from '../../../utils/migration-package/apply-package.js';
import { readMigrationPackage } from '../../../utils/migration-package/io.js';
import { formatPlan } from './plan-format.js';

export interface PackageApplyOptions {
	yes: boolean;
	dryRun: boolean;
	allowHashMismatch?: boolean | undefined;
}
/**
 * Applies a migration package to the current database.
 *
 * The compatibility check always runs first and is read-only. With
 * `--dry-run` the command stops after printing the plan; nothing is written.
 * Hard conflicts (existing fields/collections/relations, corrupted
 * bookkeeping) abort before any change.
 */
export async function packageApply(packagePath: string, options: PackageApplyOptions): Promise<void> {
	const logger = useLogger();

	const filename = path.resolve(process.cwd(), packagePath);
	const database = getDatabase();

	try {
		await validateDatabaseConnection(database);

		if ((await isInstalled()) === false) {
			logger.error(`Directus isn't installed on this database. Please run "directus bootstrap" first.`);
			database.destroy();
			return process.exit(0);
		}

		const pkg = await readMigrationPackage(filename);

		const plan = await planMigrationPackage(pkg, {
			database,
			allowHashMismatch: options.allowHashMismatch,
			// A dry run must not create anything, including the bookkeeping table
			ensureTable: options.dryRun === false,
		});

		const planText = formatPlan(pkg.steps, plan.compatibility);

		if (plan.package.steps.length === 0) {
			logger.info('Migration package contains no steps. Nothing to do.');
			database.destroy();
			return process.exit(0);
		}

		if (plan.compatibility.pending.length === 0) {
			// eslint-disable-next-line no-console
			console.log(planText);
			logger.info(`All steps of package "${pkg.id}" are already applied.`);
			database.destroy();
			return process.exit(0);
		}

		if (options.dryRun) {
			// eslint-disable-next-line no-console
			console.log(planText);
			logger.info('Dry run: no changes were written to the database.');
			database.destroy();
			return process.exit(0);
		}

		if (options.yes !== true) {
			const { proceed } = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'proceed',
					message: planText + '\n\nWould you like to continue?',
				},
			]);

			if (proceed === false) {
				database.destroy();
				return process.exit(0);
			}
		}

		// Load the license so schema changes are checked against the active limits
		await getLicenseManager().initialize();

		let appliedCount = 0;

		await applyMigrationPackage(pkg, {
			database,
			allowHashMismatch: options.allowHashMismatch,
			onStepStart: ({ index, total, name }) => {
				logger.info(`[${index}/${total}] Applying ${name}...`);
			},
			onStepComplete: () => {
				appliedCount++;
			},
		});

		logger.info(
			`Migration package "${pkg.id}" applied successfully (${appliedCount} step(s) applied, ` +
				`${plan.compatibility.completed.length} previously completed).`,
		);

		database.destroy();
		return process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}
