import { promises as fs } from 'fs';
import path from 'path';
import type { Snapshot, SnapshotDiff } from '@directus/types';
import type { ApiCollection } from '@directus/types';
import { DiffKind } from '@directus/types';
import type { Diff } from 'deep-diff';
import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, Tracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { getSnapshotDiff } from '../../../utils/schema/get-snapshot-diff.js';
import { getSnapshot } from '../../../utils/schema/get-snapshot.js';
import { diff, DiffExitCode, InvalidSnapshotError, loadSnapshotFile, SnapshotFileNotFoundError } from './diff.js';

vi.mock('../../../database/index.js');
vi.mock('../../../logger/index.js');
vi.mock('../../../utils/schema/get-snapshot-diff.js');
vi.mock('../../../utils/schema/get-snapshot.js');

class Client_PG extends MockClient {}

const mockSnapshot: Snapshot = {
	version: 1,
	directus: '10.0.0',
	vendor: 'postgres',
	collections: [],
	fields: [],
	systemFields: [],
	relations: [],
};

const emptyDiff: SnapshotDiff = {
	collections: [],
	fields: [],
	systemFields: [],
	relations: [],
};

const mockDiff: SnapshotDiff = {
	collections: [{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] }],
	fields: [],
	systemFields: [],
	relations: [],
};

describe('diff command', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: Client_PG }));
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
		vi.clearAllMocks();
	});

	describe('loadSnapshotFile', () => {
		beforeEach(() => {
			vi.spyOn(process, 'cwd').mockReturnValue('/test/dir');
		});

		test('should read a JSON snapshot file', async () => {
			vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(mockSnapshot));

			const result = await loadSnapshotFile('snapshot.json');

			expect(fs.readFile).toHaveBeenCalledWith(path.resolve('/test/dir', 'snapshot.json'), 'utf8');
			expect(result).toEqual(mockSnapshot);
		});

		test.each(['snapshot.yaml', 'snapshot.yml'])('should read a YAML snapshot file (%s)', async (filename) => {
			const yamlContent = `
version: 1
directus: '10.0.0'
vendor: postgres
collections: []
fields: []
systemFields: []
relations: []
`;

			vi.spyOn(fs, 'readFile').mockResolvedValue(yamlContent);

			const result = await loadSnapshotFile(filename);

			expect(result).toEqual(mockSnapshot);
		});

		test('should default missing groups to empty arrays', async () => {
			vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({ version: 1, directus: '10.0.0' }));

			const result = await loadSnapshotFile('snapshot.json');

			expect(result).toEqual({
				version: 1,
				directus: '10.0.0',
				vendor: undefined,
				collections: [],
				fields: [],
				systemFields: [],
				relations: [],
			});
		});

		test('should throw SnapshotFileNotFoundError if the file does not exist', async () => {
			const error = new Error('ENOENT') as Error & { code: string };
			error.code = 'ENOENT';

			vi.spyOn(fs, 'readFile').mockRejectedValue(error);

			await expect(loadSnapshotFile('missing.json')).rejects.toThrow(SnapshotFileNotFoundError);

			await expect(loadSnapshotFile('missing.json')).rejects.toThrow(
				`Snapshot file not found: ${path.resolve('/test/dir', 'missing.json')}`,
			);
		});

		test('should rethrow unexpected file system errors', async () => {
			const error = new Error('EACCES') as Error & { code: string };
			error.code = 'EACCES';

			vi.spyOn(fs, 'readFile').mockRejectedValue(error);

			await expect(loadSnapshotFile('unreadable.json')).rejects.toThrow(error);
		});

		test('should throw InvalidSnapshotError for malformed JSON', async () => {
			vi.spyOn(fs, 'readFile').mockResolvedValue('{ invalid json');

			await expect(loadSnapshotFile('snapshot.json')).rejects.toThrow(InvalidSnapshotError);
		});

		test('should throw InvalidSnapshotError for malformed YAML', async () => {
			vi.spyOn(fs, 'readFile').mockResolvedValue('version: 1\n\tinvalid: [yaml');

			await expect(loadSnapshotFile('snapshot.yaml')).rejects.toThrow(InvalidSnapshotError);
		});

		test('should throw InvalidSnapshotError for a structurally invalid snapshot', async () => {
			vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({ collections: [] }));

			await expect(loadSnapshotFile('snapshot.json')).rejects.toThrow(InvalidSnapshotError);
		});

		test('should throw InvalidSnapshotError for a non-object snapshot', async () => {
			vi.spyOn(fs, 'readFile').mockResolvedValue('just a string');

			await expect(loadSnapshotFile('snapshot.yaml')).rejects.toThrow(InvalidSnapshotError);
		});
	});

	describe('diff function', () => {
		let mockLogger: any;
		let mockDatabase: any;
		let consoleSpy: any;

		beforeEach(() => {
			mockLogger = {
				info: vi.fn(),
				error: vi.fn(),
			};

			mockDatabase = {
				destroy: vi.fn(),
			};

			vi.mocked(getDatabase).mockReturnValue(mockDatabase as Knex);
			vi.mocked(useLogger).mockReturnValue(mockLogger);
			vi.mocked(validateDatabaseConnection).mockResolvedValue(undefined);
			vi.mocked(isInstalled).mockResolvedValue(true);

			vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
			vi.spyOn(process, 'cwd').mockReturnValue('/test/dir');
			vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

			vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(mockSnapshot));

			vi.mocked(getSnapshot).mockResolvedValue(mockSnapshot);
			vi.mocked(getSnapshotDiff).mockReturnValue(emptyDiff);
		});

		describe('comparing the database against a snapshot file', () => {
			test('should exit with code 0 and report when there are no differences', async () => {
				await diff('snapshot.json', undefined, { format: 'text', ignoreRules: '' });

				expect(vi.mocked(getSnapshot)).toHaveBeenCalledWith({ database: mockDatabase });
				expect(consoleSpy).toHaveBeenCalledWith('No differences found.');
				expect(mockDatabase.destroy).toHaveBeenCalled();
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.NO_DIFFERENCES);
			});

			test('should exit with code 1 and print a human readable diff when differences are found', async () => {
				vi.mocked(getSnapshotDiff).mockReturnValue(mockDiff);

				await diff('snapshot.json', undefined, { format: 'text', ignoreRules: '' });

				const output = consoleSpy.mock.calls.join('\n');
				expect(output).toContain('The following differences were found:');
				expect(output).toContain('Collections:');
				expect(output).toContain('posts');
				expect(mockDatabase.destroy).toHaveBeenCalled();
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.DIFFERENCES_FOUND);
			});

			test('should print a machine readable JSON diff when format is json', async () => {
				vi.mocked(getSnapshotDiff).mockReturnValue(mockDiff);

				await diff('snapshot.json', undefined, { format: 'json', ignoreRules: '' });

				expect(process.stdout.write).toHaveBeenCalledTimes(1);

				const output = vi.mocked(process.stdout.write).mock.calls[0]![0] as string;
				const parsed = JSON.parse(output);

				expect(parsed).toEqual({
					collections: [{ collection: 'posts', diff: [{ kind: 'N', rhs: {} }] }],
					fields: [],
					systemFields: [],
					relations: [],
				});

				expect(consoleSpy).not.toHaveBeenCalled();
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.DIFFERENCES_FOUND);
			});

			test('should print an empty JSON diff and exit with code 0 when there are no differences', async () => {
				await diff('snapshot.json', undefined, { format: 'json', ignoreRules: '' });

				const output = vi.mocked(process.stdout.write).mock.calls[0]![0] as string;

				expect(JSON.parse(output)).toEqual(emptyDiff);
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.NO_DIFFERENCES);
			});

			test('should sort the diff for a stable output', async () => {
				vi.mocked(getSnapshotDiff).mockReturnValue({
					collections: [
						{ collection: 'users', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
						{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
					],
					fields: [],
					systemFields: [],
					relations: [],
				});

				await diff('snapshot.json', undefined, { format: 'json', ignoreRules: '' });

				const output = vi.mocked(process.stdout.write).mock.calls[0]![0] as string;
				const parsed = JSON.parse(output);

				expect(parsed.collections.map(({ collection }: any) => collection)).toEqual(['posts', 'users']);
			});

			test('should ignore collections and fields matching the ignoreRules', async () => {
				vi.mocked(getSnapshotDiff).mockReturnValue({
					collections: [
						{ collection: 'users', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
						{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
					],
					fields: [],
					systemFields: [],
					relations: [],
				});

				await diff('snapshot.json', undefined, { format: 'json', ignoreRules: 'users' });

				const output = vi.mocked(process.stdout.write).mock.calls[0]![0] as string;
				const parsed = JSON.parse(output);

				expect(parsed.collections).toHaveLength(1);
				expect(parsed.collections[0].collection).toBe('posts');
			});

			test('should exit with code 0 when all differences are ignored', async () => {
				vi.mocked(getSnapshotDiff).mockReturnValue(mockDiff);

				await diff('snapshot.json', undefined, { format: 'text', ignoreRules: 'posts' });

				expect(consoleSpy).toHaveBeenCalledWith('No differences found.');
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.NO_DIFFERENCES);
			});

			test('should exit with code 2 when the snapshot file does not exist', async () => {
				const error = new Error('ENOENT') as Error & { code: string };
				error.code = 'ENOENT';

				vi.mocked(fs.readFile).mockRejectedValue(error);

				await diff('missing.json', undefined, { format: 'text', ignoreRules: '' });

				expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Snapshot file not found'));
				// Fails before a database connection is made
				expect(getDatabase).not.toHaveBeenCalled();
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.FILE_NOT_FOUND);
			});

			test('should exit with code 3 when the snapshot file is invalid', async () => {
				vi.mocked(fs.readFile).mockResolvedValue('{ invalid json');

				await diff('snapshot.json', undefined, { format: 'text', ignoreRules: '' });

				expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
				// Fails before a database connection is made
				expect(getDatabase).not.toHaveBeenCalled();
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.INVALID_SNAPSHOT);
			});

			test('should exit with code 4 when Directus is not installed', async () => {
				vi.mocked(isInstalled).mockResolvedValue(false);

				await diff('snapshot.json', undefined, { format: 'text', ignoreRules: '' });

				expect(mockLogger.error).toHaveBeenCalledWith(
					expect.stringContaining("Directus isn't installed on this database"),
				);

				expect(mockDatabase.destroy).toHaveBeenCalled();
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.ERROR);
			});

			test('should exit with code 4 when the database connection fails', async () => {
				vi.mocked(validateDatabaseConnection).mockRejectedValue(new Error('Connection failed'));

				await diff('snapshot.json', undefined, { format: 'text', ignoreRules: '' });

				expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error));
				expect(mockDatabase.destroy).toHaveBeenCalled();
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.ERROR);
			});

			test('should exit with code 4 on unexpected errors', async () => {
				vi.mocked(getSnapshot).mockRejectedValue(new Error('Unexpected'));

				await diff('snapshot.json', undefined, { format: 'text', ignoreRules: '' });

				expect(mockLogger.error).toHaveBeenCalledWith(expect.any(Error));
				expect(mockDatabase.destroy).toHaveBeenCalled();
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.ERROR);
			});
		});

		describe('comparing two snapshot files', () => {
			const baseSnapshot: Snapshot = {
				...mockSnapshot,
				collections: [{ collection: 'posts' } as Snapshot['collections'][number]],
			};

			beforeEach(() => {
				vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
					if (String(filePath).endsWith('base.json')) {
						return JSON.stringify(baseSnapshot);
					}

					return JSON.stringify(mockSnapshot);
				});
			});

			test('should not connect to the database', async () => {
				await diff('base.json', 'target.json', { format: 'text', ignoreRules: '' });

				expect(getDatabase).not.toHaveBeenCalled();
				expect(vi.mocked(validateDatabaseConnection)).not.toHaveBeenCalled();
				expect(vi.mocked(isInstalled)).not.toHaveBeenCalled();
				expect(vi.mocked(getSnapshot)).not.toHaveBeenCalled();
			});

			test('should diff the base file against the target file', async () => {
				await diff('base.json', 'target.json', { format: 'text', ignoreRules: '' });

				expect(vi.mocked(getSnapshotDiff)).toHaveBeenCalledWith(
					expect.objectContaining({ collections: [{ collection: 'posts' }] }),
					expect.objectContaining({ collections: [] }),
				);

				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.NO_DIFFERENCES);
			});

			test('should exit with code 1 when the files differ', async () => {
				vi.mocked(getSnapshotDiff).mockReturnValue(mockDiff);

				await diff('base.json', 'target.json', { format: 'json', ignoreRules: '' });

				const output = vi.mocked(process.stdout.write).mock.calls[0]![0] as string;

				expect(JSON.parse(output).collections).toHaveLength(1);
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.DIFFERENCES_FOUND);
			});

			test('should exit with code 2 when the base file does not exist', async () => {
				const error = new Error('ENOENT') as Error & { code: string };
				error.code = 'ENOENT';

				vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
					if (String(filePath).endsWith('base.json')) {
						throw error;
					}

					return JSON.stringify(mockSnapshot);
				});

				await diff('base.json', 'target.json', { format: 'text', ignoreRules: '' });

				expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Snapshot file not found'));
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.FILE_NOT_FOUND);
			});

			test('should exit with code 3 when the base file is invalid', async () => {
				vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
					if (String(filePath).endsWith('base.json')) {
						return JSON.stringify({ invalid: true });
					}

					return JSON.stringify(mockSnapshot);
				});

				await diff('base.json', 'target.json', { format: 'text', ignoreRules: '' });

				expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid snapshot'));
				expect(process.exit).toHaveBeenCalledWith(DiffExitCode.INVALID_SNAPSHOT);
			});
		});
	});
});
