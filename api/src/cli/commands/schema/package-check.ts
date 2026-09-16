import path from 'path';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { planMigrationPackage } from '../../../utils/migration-package/apply-package.js';
import { readMigrationPackage } from '../../../utils/migration-package/io.js';
import { formatPlan } from './plan-format.js';

export interface PackageCheckOptions {
	allowHashMismatch?: boolean | undefined;
}

/**
 * Runs the read-only compatibility check of a migration package against the
 * current database and prints the execution plan. Never writes to the database.
 */
export async function packageCheck(packagePath: string, options: PackageCheckOptions): Promise<void> {
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
			ensureTable: false,
		});

		// eslint-disable-next-line no-console
		console.log(formatPlan(pkg.steps, plan.compatibility));

		logger.info(
			`Compatibility check passed: ${plan.compatibility.pending.length} pending, ` +
				`${plan.compatibility.completed.length} already completed.`,
		);

		database.destroy();
		return process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}
