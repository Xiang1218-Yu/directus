import path from 'path';
import inquirer from 'inquirer';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { applyMigrationPackage, planMigrationPackage } from '../../../utils/migration-package/apply-package.js';
import { readMigrationPackage } from '../../../utils/migration-package/io.js';
import { formatPlan } from './plan-format.js';

export interface PackageRollbackOptions {
	yes: boolean;
	dryRun: boolean;
	allowHashMismatch?: boolean | undefined;
}

/**
 * Reverts an applied migration package back to its "from" snapshot using the
 * package's embedded rollback steps.
 *
 * Compatibility is checked first (read-only), the forward application must be
 * complete, and `--dry-run` only prints the rollback plan.
 */
export async function packageRollback(packagePath: string, options: PackageRollbackOptions): Promise<void> {
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

		if (!pkg.rollback || pkg.rollback.length === 0) {
			logger.error(`Migration package "${pkg.id}" contains no rollback steps; it cannot be reverted.`);
			database.destroy();
			return process.exit(1);
		}

		const plan = await planMigrationPackage(pkg, {
			database,
			allowHashMismatch: options.allowHashMismatch,
			direction: 'down',
		});

		const planText = formatPlan(pkg.rollback, plan.compatibility);

		if (options.dryRun) {
			// eslint-disable-next-line no-console
			console.log(planText);
			logger.info('Dry run: no changes were written to the database.');
			database.destroy();
			return process.exit(0);
		}

		if (plan.compatibility.pending.length === 0) {
			// eslint-disable-next-line no-console
			console.log(planText);
			logger.info(`All rollback steps of package "${pkg.id}" are already completed.`);
			database.destroy();
			return process.exit(0);
		}

		if (options.yes !== true) {
			const { proceed } = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'proceed',
					message: planText + '\n\nRoll back these changes?',
				},
			]);

			if (proceed === false) {
				database.destroy();
				return process.exit(0);
			}
		}

		let appliedCount = 0;

		await applyMigrationPackage(pkg, {
			database,
			allowHashMismatch: options.allowHashMismatch,
			direction: 'down',
			onStepStart: ({ index, total, name }) => {
				logger.info(`[${index}/${total}] Rolling back ${name}...`);
			},
			onStepComplete: () => {
				appliedCount++;
			},
		});

		logger.info(
			`Migration package "${pkg.id}" rolled back successfully (${appliedCount} step(s) rolled back, ` +
				`${plan.compatibility.completed.length} previously rolled back).`,
		);

		database.destroy();
		return process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}
