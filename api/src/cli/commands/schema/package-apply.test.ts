import type { Knex } from 'knex';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { getLicenseManager } from '../../../license/index.js';
import { useLogger } from '../../../logger/index.js';
import { applyMigrationPackage, planMigrationPackage } from '../../../utils/migration-package/apply-package.js';
import { readMigrationPackage } from '../../../utils/migration-package/io.js';
import { packageApply } from './package-apply.js';

vi.mock('inquirer');
vi.mock('../../../database/index.js');
vi.mock('../../../license/index.js');
vi.mock('../../../logger/index.js');
vi.mock('../../../utils/migration-package/io.js');
vi.mock('../../../utils/migration-package/apply-package.js');

const validPackage = {
	kind: 'directus.schema-migration-package',
	version: 1,
	id: 'cli-test-package',
	metadata: { createdAt: '2026-01-01T00:00:00.000Z' },
	from: { version: 1, directus: '11.0.0' },
	to: { version: 1, directus: '11.0.0' },
	steps: [
		{
			id: '0001-create-collection-posts',
			name: 'create collection posts',
			kind: 'create-collection',
			collection: 'posts',
			diff: {
				collections: [
					{
						collection: 'posts',
						diff: [{ kind: 'N', rhs: { collection: 'posts', meta: {}, schema: {} } }],
					},
				],
				fields: [],
				systemFields: [],
				relations: [],
			},
		},
	],
};

describe('schema package apply command', () => {
	let mockLogger: any;
	let mockDatabase: any;

	beforeEach(() => {
		vi.clearAllMocks();

		mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
		mockDatabase = { destroy: vi.fn() };

		vi.mocked(useLogger).mockReturnValue(mockLogger);
		vi.mocked(getDatabase).mockReturnValue(mockDatabase as unknown as Knex);
		vi.mocked(validateDatabaseConnection).mockResolvedValue(undefined);
		vi.mocked(isInstalled).mockResolvedValue(true);
		vi.mocked(getLicenseManager).mockReturnValue({ initialize: vi.fn().mockResolvedValue(undefined) } as any);
		vi.mocked(readMigrationPackage).mockResolvedValue(structuredClone(validPackage) as any);

		vi.mocked(planMigrationPackage).mockResolvedValue({
			package: validPackage,
			currentSnapshot: {},
			compatibility: {
				issues: [],
				completed: [],
				pending: validPackage.steps.map((step) => step.id),
				resumable: false,
			},
		} as any);

		vi.mocked(applyMigrationPackage).mockResolvedValue({ applied: ['0001-create-collection-posts'], skipped: [] });

		vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
		vi.spyOn(process, 'cwd').mockReturnValue('/test/dir');
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	test('validates the database connection first', async () => {
		vi.mocked(validateDatabaseConnection).mockRejectedValue(new Error('Connection failed'));

		await packageApply('pkg.json', { yes: true, dryRun: false });

		expect(vi.mocked(validateDatabaseConnection)).toHaveBeenCalledWith(mockDatabase);
		expect(readMigrationPackage).not.toHaveBeenCalled();
		expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error));
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	test('errors when Directus is not installed', async () => {
		vi.mocked(isInstalled).mockResolvedValue(false);

		await packageApply('pkg.json', { yes: true, dryRun: false });

		expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("Directus isn't installed on this database"));

		expect(process.exit).toHaveBeenCalledWith(0);
		expect(mockDatabase.destroy).toHaveBeenCalled();
	});

	test('reads package file from resolved cwd path', async () => {
		await packageApply('migrations/pkg.yaml', { yes: true, dryRun: false });

		expect(readMigrationPackage).toHaveBeenCalledWith('/test/dir/migrations/pkg.yaml');
	});

	test('dry-run plans without applying and without license checks', async () => {
		await packageApply('pkg.json', { yes: false, dryRun: true });

		expect(planMigrationPackage).toHaveBeenCalled();
		expect(applyMigrationPackage).not.toHaveBeenCalled();
		expect(getLicenseManager().initialize).not.toHaveBeenCalled();
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	test('applies with --yes and records per-step progress callbacks', async () => {
		await packageApply('pkg.json', { yes: true, dryRun: false });

		expect(applyMigrationPackage).toHaveBeenCalledTimes(1);
		const [, passedOptions] = vi.mocked(applyMigrationPackage).mock.calls[0]!;
		expect(passedOptions!.database).toBe(mockDatabase);
		expect(typeof passedOptions!.onStepStart).toBe('function');

		passedOptions!.onStepStart!({ index: 1, total: 1, stepId: 's1', name: 'create collection posts' });
		expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('create collection posts'));

		expect(process.exit).toHaveBeenCalledWith(0);
	});

	test('prints plan and exits early when all steps are already completed', async () => {
		vi.mocked(planMigrationPackage).mockResolvedValue({
			package: validPackage,
			currentSnapshot: {},
			compatibility: {
				issues: [],
				completed: validPackage.steps.map((step) => step.id),
				pending: [],
				resumable: false,
			},
		} as any);

		await packageApply('pkg.json', { yes: true, dryRun: false });

		expect(applyMigrationPackage).not.toHaveBeenCalled();
		expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('already applied'));
	});

	test('logs and exits non-zero when the apply fails mid-package', async () => {
		vi.mocked(applyMigrationPackage).mockRejectedValue(new Error('step boom'));

		await packageApply('pkg.json', { yes: true, dryRun: false });

		expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error));
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	test('propagates hard compatibility conflicts before applying', async () => {
		vi.mocked(planMigrationPackage).mockRejectedValue(new Error('incompatible'));

		await packageApply('pkg.json', { yes: true, dryRun: false });

		expect(applyMigrationPackage).not.toHaveBeenCalled();
		expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error));
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});
