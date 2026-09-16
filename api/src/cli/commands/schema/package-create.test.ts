import { promises as fs } from 'fs';
import { DiffKind } from '@directus/types';
import type { Knex } from 'knex';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import getDatabase from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { buildMigrationPackage } from '../../../utils/migration-package/build-package.js';
import { getSnapshotDiff } from '../../../utils/schema/get-snapshot-diff.js';
import { getSnapshot } from '../../../utils/schema/get-snapshot.js';
import { packageCreate } from './package-create.js';

vi.mock('inquirer');
vi.mock('../../../database/index.js');
vi.mock('../../../logger/index.js');

vi.mock('../../../utils/get-versioned-hash.js', () => ({
	getVersionedHash: vi.fn(() => 'hash'),
}));

vi.mock('../../../utils/schema/get-snapshot.js');
vi.mock('../../../utils/schema/get-snapshot-diff.js');
vi.mock('../../../utils/migration-package/build-package.js');

vi.mock('../../../utils/migration-package/validate-package.js', () => ({
	validateMigrationPackage: vi.fn(),
}));

const snapshot = () => ({
	version: 1,
	directus: '11.0.0',
	collections: [],
	fields: [],
	systemFields: [],
	relations: [],
});

describe('schema package create command', () => {
	let mockLogger: any;
	let mockDatabase: any;
	let stdoutSpy: any;

	beforeEach(() => {
		vi.clearAllMocks();

		mockLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
		mockDatabase = { destroy: vi.fn() };

		vi.mocked(useLogger).mockReturnValue(mockLogger);
		vi.mocked(getDatabase).mockReturnValue(mockDatabase as unknown as Knex);
		vi.mocked(getSnapshot).mockResolvedValue(snapshot());

		vi.mocked(getSnapshotDiff).mockReturnValue({
			collections: [
				{
					collection: 'posts',
					diff: [{ kind: DiffKind.NEW, rhs: { collection: 'posts', meta: {}, schema: {} } }],
				},
			],
			fields: [],
			systemFields: [],
			relations: [],
		} as any);

		vi.mocked(buildMigrationPackage).mockImplementation(((_diff: unknown, options: unknown) => ({
			kind: 'directus.schema-migration-package',
			version: 1,
			id: (options as { id: string }).id,
			metadata: { createdAt: '2026-01-01T00:00:00.000Z' },
			from: { version: 1, directus: '11.0.0' },
			to: { version: 1, directus: '11.0.0' },
			steps: [{ id: '0001-create-collection-posts' }],
		})) as any);

		vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
		vi.spyOn(process, 'cwd').mockReturnValue('/test/dir');
		stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
	});

	test('diff target snapshot file against the live database by default', async () => {
		vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(snapshot()));

		await packageCreate('target.yaml', { yes: true, format: 'yaml' });

		expect(getSnapshot).toHaveBeenCalledWith({ database: mockDatabase });
		expect(getSnapshotDiff).toHaveBeenCalledTimes(2); // forward + rollback diffs

		expect(buildMigrationPackage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ fromHash: 'hash', toHash: 'hash', rollbackDiff: expect.any(Object) }),
		);
	});

	test('omits rollback steps with --no-rollback', async () => {
		vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(snapshot()));

		await packageCreate('target.json', { yes: true, format: 'json', rollback: false });

		expect(getSnapshotDiff).toHaveBeenCalledTimes(1);

		expect(buildMigrationPackage).toHaveBeenCalledWith(
			expect.anything(),
			expect.not.objectContaining({ rollbackDiff: expect.anything() }),
		);
	});

	test('reads a --from snapshot file without touching the live schema', async () => {
		vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(snapshot()));

		await packageCreate('target.json', { yes: true, format: 'json', from: 'source.json' });

		expect(getSnapshot).not.toHaveBeenCalled();
	});

	test('writes YAML to an output file', async () => {
		vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(snapshot()));
		const writeSpy = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
		vi.spyOn(fs, 'access').mockRejectedValue(new Error('does not exist'));

		await packageCreate('target.yaml', { yes: true, format: 'yaml', id: 'pkg-42' }, 'out/pkg.yaml');

		expect(writeSpy).toHaveBeenCalledWith('/test/dir/out/pkg.yaml', expect.stringContaining('kind:'));
		expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('pkg-42'));
	});

	test('writes JSON when format is json', async () => {
		vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(snapshot()));
		const writeSpy = vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
		vi.spyOn(fs, 'access').mockRejectedValue(new Error('does not exist'));

		await packageCreate('target.json', { yes: true, format: 'json' }, 'out/pkg.json');

		const content = writeSpy.mock.calls[0]![1] as string;
		expect(JSON.parse(content).kind).toBe('directus.schema-migration-package');
	});

	test('writes to stdout when no output path is given', async () => {
		vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(snapshot()));

		await packageCreate('target.json', { yes: true, format: 'json' });

		expect(stdoutSpy).toHaveBeenCalled();
	});

	test('forwards author and description metadata', async () => {
		vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(snapshot()));

		await packageCreate('target.json', {
			yes: true,
			format: 'json',
			author: 'ci-bot',
			description: 'add posts',
		});

		expect(buildMigrationPackage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				metadata: expect.objectContaining({ author: 'ci-bot', description: 'add posts' }),
			}),
		);
	});

	test('logs errors and exits non-zero on failure', async () => {
		vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('missing file'));

		await packageCreate('nope.json', { yes: true, format: 'json' });

		expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error));
		expect(process.exit).toHaveBeenCalledWith(1);
	});
});
