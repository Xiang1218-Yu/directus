import type { Knex } from 'knex';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { applyMigrationPackage, planMigrationPackage } from '../../../utils/migration-package/apply-package.js';
import { readMigrationPackage } from '../../../utils/migration-package/io.js';
import { packageRollback } from './package-rollback.js';

vi.mock('inquirer');
vi.mock('../../../database/index.js');
vi.mock('../../../logger/index.js');
vi.mock('../../../utils/migration-package/io.js');
vi.mock('../../../utils/migration-package/apply-package.js');

const rollbackStep = {
	id: '0001-delete-collection-posts',
	name: 'delete collection posts',
	kind: 'delete-collection',
	collection: 'posts',
	diff: {
		collections: [
			{
				collection: 'posts',
				diff: [{ kind: 'D', lhs: { collection: 'posts' } }],
			},
		],
		fields: [],
		systemFields: [],
		relations: [],
	},
};

const validPackage = {
	kind: 'directus.schema-migration-package',
	version: 1,
	id: 'cli-rb-package',
	metadata: { createdAt: '2026-01-01T00:00:00.000Z' },
	from: { version: 1, directus: '11.0.0' },
	to: { version: 1, directus: '11.0.0' },
	steps: [
		{
			id: '0001-create-collection-posts',
			name: 'create collection posts',
			kind: 'create-collection',
			collection: 'posts',
			diff: { collections: [], fields: [], systemFields: [], relations: [] },
		},
	],
	rollback: [rollbackStep],
};

describe('schema package rollback command', () => {
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
			direction: 'down',
			compatibility: {
				issues: [],
				completed: [],
				pending: validPackage.rollback.map((step) => step.id),
				resumable: false,
			},
		} as any);

		vi.mocked(applyMigrationPackage).mockResolvedValue({ applied: ['0001-delete-collection-posts'], skipped: [] });

		vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
		vi.spyOn(process, 'cwd').mockReturnValue('/test/dir');
		vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	test('errors when the package contains no rollback steps', async () => {
		vi.mocked(readMigrationPackage).mockResolvedValue({ ...validPackage, rollback: undefined } as any);

		await packageRollback('pkg.json', { yes: true, dryRun: false });

		expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('no rollback steps'));
		expect(applyMigrationPackage).not.toHaveBeenCalled();
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	test('dry-run plans in the down direction without applying', async () => {
		await packageRollback('pkg.json', { yes: false, dryRun: true });

		expect(planMigrationPackage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ direction: 'down' }),
		);

		expect(applyMigrationPackage).not.toHaveBeenCalled();
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	test('applies with --yes in the down direction', async () => {
		await packageRollback('pkg.json', { yes: true, dryRun: false });

		expect(applyMigrationPackage).toHaveBeenCalledTimes(1);
		const [, passedOptions] = vi.mocked(applyMigrationPackage).mock.calls[0]!;
		expect(passedOptions!.direction).toBe('down');
		expect(passedOptions!.database).toBe(mockDatabase);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	test('reports errors and exits non-zero when the compatibility check fails', async () => {
		vi.mocked(planMigrationPackage).mockRejectedValue(new Error('forward steps missing'));

		await packageRollback('pkg.json', { yes: true, dryRun: false });

		expect(applyMigrationPackage).not.toHaveBeenCalled();
		expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error));
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});
