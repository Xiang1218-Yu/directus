import type { Knex } from 'knex';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { planMigrationPackage } from '../../../utils/migration-package/apply-package.js';
import { readMigrationPackage } from '../../../utils/migration-package/io.js';
import { packageCheck } from './package-check.js';

vi.mock('../../../database/index.js');
vi.mock('../../../logger/index.js');
vi.mock('../../../utils/migration-package/io.js');
vi.mock('../../../utils/migration-package/apply-package.js');

const validPackage = {
	kind: 'directus.schema-migration-package',
	version: 1,
	id: 'cli-check-package',
	metadata: { createdAt: '2026-01-01T00:00:00.000Z' },
	from: { version: 1, directus: '11.0.0' },
	to: { version: 1, directus: '11.0.0' },
	steps: [],
};

describe('schema package check command', () => {
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
		vi.mocked(readMigrationPackage).mockResolvedValue(structuredClone(validPackage) as any);

		vi.mocked(planMigrationPackage).mockResolvedValue({
			package: validPackage,
			currentSnapshot: {},
			compatibility: { issues: [], completed: [], pending: [], resumable: false },
		} as any);

		vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
		vi.spyOn(process, 'cwd').mockReturnValue('/test/dir');
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	test('plans without applying and exits successfully', async () => {
		await packageCheck('pkg.yaml', {});

		expect(readMigrationPackage).toHaveBeenCalledWith('/test/dir/pkg.yaml');

		expect(planMigrationPackage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ database: mockDatabase }),
		);

		expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Compatibility check passed'));
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	test('forwards allowHashMismatch to the planner', async () => {
		await packageCheck('pkg.json', { allowHashMismatch: true });

		expect(planMigrationPackage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ allowHashMismatch: true }),
		);
	});

	test('fails before planning when Directus is not installed', async () => {
		vi.mocked(isInstalled).mockResolvedValue(false);

		await packageCheck('pkg.json', {});

		expect(planMigrationPackage).not.toHaveBeenCalled();
		expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining("Directus isn't installed"));
	});

	test('surfaces compatibility errors without writing anything', async () => {
		vi.mocked(planMigrationPackage).mockRejectedValue(new Error('incompatible target'));

		await packageCheck('pkg.json', {});

		expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error));
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});
