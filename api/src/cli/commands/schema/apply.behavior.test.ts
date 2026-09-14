import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Snapshot } from '@directus/types';
import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import getDatabase, { isInstalled, validateDatabaseConnection } from '../../../database/index.js';
import { getLicenseManager } from '../../../license/index.js';
import { useLogger } from '../../../logger/index.js';
import { applySnapshot } from '../../../utils/schema/apply-snapshot.js';
import { getSnapshot } from '../../../utils/schema/get-snapshot.js';
import { apply } from './apply.js';

/**
 * Boundary seams replaced for these behavior tests:
 * - the database layer (connection / install probe / the write-side `applySnapshot`)
 * - `getSnapshot`, which normally pulls the full service layer to introspect the DB
 * - the license manager and the logger
 *
 * Everything on the command's own decision path runs for real: JSON (`parseJSON`) and YAML
 * (`js-yaml`) parsing, the real `getSnapshotDiff` + `filterSnapshotDiff`, the diff renderer,
 * the inquirer prompt wiring, and actual file I/O against temp files.
 */
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(),
	isInstalled: vi.fn(),
	validateDatabaseConnection: vi.fn(),
}));

vi.mock('../../../license/index.js', () => ({ getLicenseManager: vi.fn() }));
vi.mock('../../../logger/index.js', () => ({ useLogger: vi.fn() }));
vi.mock('../../../utils/schema/apply-snapshot.js', () => ({ applySnapshot: vi.fn() }));
vi.mock('../../../utils/schema/get-snapshot.js', () => ({ getSnapshot: vi.fn() }));

class ProcessExitSignal extends Error {
	constructor(public readonly code: number) {
		super(`process.exit(${code})`);
	}
}

/** Minimal schema with a single collection and its primary key field. */
function currentSnapshot(): Snapshot {
	return {
		version: 1,
		directus: '11.0.0',
		collections: [{ collection: 'articles', meta: null, schema: { name: 'articles' } }],
		fields: [{ collection: 'articles', field: 'id', type: 'integer', meta: null as any, schema: null } as any],
		systemFields: [],
		relations: [],
	};
}

/**
 * Target schema that, diffed against {@link currentSnapshot} via the *real* diff engine,
 * yields changes across every section:
 * - collections: edit `articles` (meta), create `authors` and `logs`
 * - fields: create `articles.title` and `articles.slug`
 * - relations: create `articles.author_id -> authors` and `articles.log_id -> logs`
 */
function targetSnapshot(): Snapshot {
	return {
		version: 1,
		directus: '11.0.0',
		collections: [
			{ collection: 'articles', meta: { hidden: false } as any, schema: { name: 'articles' } },
			{ collection: 'authors', meta: null, schema: { name: 'authors' } },
			{ collection: 'logs', meta: null, schema: { name: 'logs' } },
		],
		fields: [
			{ collection: 'articles', field: 'id', type: 'integer', meta: null as any, schema: null } as any,
			{ collection: 'articles', field: 'title', type: 'string', meta: null as any, schema: null } as any,
			{ collection: 'articles', field: 'slug', type: 'string', meta: null as any, schema: null } as any,
		],
		systemFields: [],
		relations: [
			{
				collection: 'articles',
				field: 'author_id',
				related_collection: 'authors',
				meta: null as any,
				schema: null,
			} as any,
			{ collection: 'articles', field: 'log_id', related_collection: 'logs', meta: null as any, schema: null } as any,
		],
	};
}

describe('schema apply command', () => {
	const tempDirs: string[] = [];
	let mockLogger: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
	let mockDatabase: { destroy: ReturnType<typeof vi.fn> };
	let mockLicenseManager: { initialize: ReturnType<typeof vi.fn> };
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	/**
	 * Run the command exactly like commander does and capture the exit code. `process.exit` is
	 * turned into a thrown signal so execution truly stops where the real process would stop;
	 * this keeps assertions after an exit from observing code the command never runs.
	 */
	async function runApply(filePath: string, options?: { yes?: boolean; dryRun?: boolean; ignoreRules?: string }) {
		let exitCode: number | undefined;

		try {
			await apply(filePath, { yes: false, dryRun: false, ignoreRules: '', ...(options ?? {}) });
		} catch (error) {
			if (error instanceof ProcessExitSignal) {
				exitCode = error.code;
			} else {
				// An unexpected exception escaped the command's catch block; surface it loudly.
				throw error;
			}
		}

		return exitCode;
	}

	async function writeSnapshot(filename: string, contents: string) {
		const dir = await mkdtemp(path.join(tmpdir(), 'schema-apply-'));
		tempDirs.push(dir);
		const fullPath = path.join(dir, filename);
		await writeFile(fullPath, contents, 'utf8');
		return fullPath;
	}

	beforeEach(() => {
		mockLogger = {
			info: vi.fn(),
			error: vi.fn((error: unknown) => {
				// The command's try/catch encloses its own process.exit() calls. A real process
				// terminates inside exit(), so an intercepted exit must propagate instead of being
				// swallowed by the catch (which would otherwise log it and fall through to exit(1)).
				// Genuine errors are logged and returned, letting cleanup + exit(1) run as in production.
				if (error instanceof ProcessExitSignal) throw error;
			}),
		};

		mockDatabase = { destroy: vi.fn() };
		mockLicenseManager = { initialize: vi.fn().mockResolvedValue(undefined) };

		vi.mocked(useLogger).mockReturnValue(mockLogger as any);
		vi.mocked(getDatabase).mockReturnValue(mockDatabase as any);
		vi.mocked(validateDatabaseConnection).mockResolvedValue(undefined);
		vi.mocked(isInstalled).mockResolvedValue(true);
		vi.mocked(getLicenseManager).mockReturnValue(mockLicenseManager as any);
		vi.mocked(getSnapshot).mockResolvedValue(currentSnapshot());
		vi.mocked(applySnapshot).mockResolvedValue(undefined);
		vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true });

		vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
			throw new ProcessExitSignal(code ?? 0);
		}) as any);

		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();

		await Promise.all(
			tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
		);
	});

	describe('snapshot input formats', () => {
		test('applies a JSON snapshot parsed from disk', async () => {
			const snapshot = targetSnapshot();
			const filePath = await writeSnapshot('snapshot.json', JSON.stringify(snapshot));

			const code = await runApply(filePath, { yes: true });

			expect(code).toBe(0);
			expect(vi.mocked(applySnapshot)).toHaveBeenCalledTimes(1);

			expect(vi.mocked(applySnapshot)).toHaveBeenCalledWith(
				snapshot,
				expect.objectContaining({ database: mockDatabase }),
			);

			expect(mockLogger.info).toHaveBeenCalledWith('Snapshot applied successfully');
		});

		test('applies a YAML snapshot parsed from disk', async () => {
			const yaml = [
				'version: 1',
				'directus: 11.0.0',
				'collections:',
				'  - collection: articles',
				'    meta: null',
				'    schema:',
				'      name: articles',
				'  - collection: authors',
				'    meta: null',
				'    schema:',
				'      name: authors',
				'fields:',
				'  - collection: articles',
				'    field: id',
				'    type: integer',
				'    meta: null',
				'    schema: null',
				'  - collection: articles',
				'    field: title',
				'    type: string',
				'    meta: null',
				'    schema: null',
				'relations:',
				'  - collection: articles',
				'    field: author_id',
				'    related_collection: authors',
				'    meta: null',
				'    schema: null',
				'systemFields: []',
			].join('\n');

			const filePath = await writeSnapshot('snapshot.yaml', yaml);

			const code = await runApply(filePath, { yes: true });

			expect(code).toBe(0);
			expect(vi.mocked(applySnapshot)).toHaveBeenCalledTimes(1);

			const applied = vi.mocked(applySnapshot).mock.calls[0]!;
			const appliedDiff = applied[1]!.diff!;
			expect(appliedDiff.collections.map(({ collection }) => collection)).toContain('authors');
			expect(appliedDiff.fields.map(({ field }) => field)).toContain('title');
			expect(appliedDiff.relations.map(({ field }) => field)).toContain('author_id');
		});
	});

	describe('no changes', () => {
		test('logs "No changes to apply.", exits 0 and never touches the write side', async () => {
			const snapshot = currentSnapshot();
			const filePath = await writeSnapshot('identical.json', JSON.stringify(snapshot));

			const code = await runApply(filePath, { yes: true });

			expect(code).toBe(0);
			expect(mockLogger.info).toHaveBeenCalledWith('No changes to apply.');
			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();
			expect(vi.mocked(getLicenseManager)).not.toHaveBeenCalled();
			expect(vi.mocked(inquirer.prompt)).not.toHaveBeenCalled();
		});
	});

	describe('--dry-run', () => {
		test('prints the planned changes, exits 0 and does not initialize the license or write to the database', async () => {
			const filePath = await writeSnapshot('target.json', JSON.stringify(targetSnapshot()));

			const code = await runApply(filePath, { dryRun: true });

			expect(code).toBe(0);
			expect(consoleLogSpy).toHaveBeenCalledTimes(1);

			const output = consoleLogSpy.mock.calls[0]!.join(' ');
			expect(output).toContain('The following changes will be applied:');
			expect(output).toContain('Collections:');
			expect(output).toContain('Create');
			expect(output).toContain('authors');
			expect(output).toContain('logs');
			expect(output).toContain('Fields:');
			expect(output).toContain('articles.title');
			expect(output).toContain('articles.slug');
			expect(output).toContain('Relations:');
			expect(output).toContain('articles.author_id → authors');
			expect(output).toContain('articles.log_id → logs');

			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();
			expect(vi.mocked(inquirer.prompt)).not.toHaveBeenCalled();
			expect(mockLicenseManager.initialize).not.toHaveBeenCalled();

			// NOTE (cleanup gap): unlike the no-changes and not-installed paths, dry-run calls
			// process.exit(0) without database.destroy(); assert current behavior to pin it down.
			expect(mockDatabase.destroy).not.toHaveBeenCalled();
		});

		test('characterizes how object-valued edits are shown (see note)', async () => {
			// An edit whose new value is an object (here: collection meta goes from null to an object).
			vi.mocked(getSnapshot).mockResolvedValue({
				...currentSnapshot(),
				collections: [{ collection: 'articles', meta: null, schema: { name: 'articles' } }],
			});

			const target: Snapshot = {
				...currentSnapshot(),
				collections: [{ collection: 'articles', meta: { hidden: true } as any, schema: { name: 'articles' } }],
			};

			const filePath = await writeSnapshot('meta-edit.json', JSON.stringify(target));

			const code = await runApply(filePath, { dryRun: true });

			expect(code).toBe(0);
			const output = consoleLogSpy.mock.calls[0]!.join(' ');
			expect(output).toContain('Update articles');

			// KNOWN DISPLAY ISSUE (apply.ts renders `Set ${path} to ${change.rhs}`): object values
			// are stringified as "[object Object]", so the plan shows no useful detail. The desired
			// output would render the value (e.g. JSON). Asserted only to characterize the current
			// behavior and keep a regression visible until the renderer is fixed — not to bless it.
			expect(output).toContain('Set meta to [object Object]');
			expect(output).not.toContain('hidden');
		});
	});

	describe('--yes', () => {
		test('skips the interactive prompt and applies the snapshot', async () => {
			const filePath = await writeSnapshot('target.json', JSON.stringify(targetSnapshot()));

			const code = await runApply(filePath, { yes: true });

			expect(code).toBe(0);
			expect(vi.mocked(inquirer.prompt)).not.toHaveBeenCalled();
			expect(vi.mocked(applySnapshot)).toHaveBeenCalledTimes(1);
		});

		test('prompts by default and proceeds after confirmation', async () => {
			const filePath = await writeSnapshot('target.json', JSON.stringify(targetSnapshot()));

			const code = await runApply(filePath);

			expect(code).toBe(0);
			expect(vi.mocked(inquirer.prompt)).toHaveBeenCalledTimes(1);
			const question = ((vi.mocked(inquirer.prompt).mock.calls[0] as any[])[0] as any[])[0];
			expect(question).toMatchObject({ type: 'confirm', name: 'proceed' });
			expect(question.message).toContain('Would you like to continue?');
			expect(question.message).toContain('authors');
			expect(vi.mocked(applySnapshot)).toHaveBeenCalledTimes(1);
		});

		test('prompts by default and exits 0 without applying when declined', async () => {
			vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: false });
			const filePath = await writeSnapshot('target.json', JSON.stringify(targetSnapshot()));

			const code = await runApply(filePath);

			expect(code).toBe(0);
			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();

			// NOTE (cleanup gap): declining the prompt exits without database.destroy().
			expect(mockDatabase.destroy).not.toHaveBeenCalled();
		});
	});

	describe('--ignoreRules', () => {
		test('filters collections, fields and relations in the same run', async () => {
			const filePath = await writeSnapshot('target.json', JSON.stringify(targetSnapshot()));

			const code = await runApply(filePath, {
				yes: true,
				// one rule of each kind, applied together
				ignoreRules: 'logs,articles.slug,articles.author_id',
			});

			expect(code).toBe(0);
			expect(vi.mocked(applySnapshot)).toHaveBeenCalledTimes(1);

			const diff = vi.mocked(applySnapshot).mock.calls[0]![1]!.diff!;

			// The collection rule removes only the matching collection, not its sibling resources.
			expect(diff.collections.map(({ collection }) => collection)).not.toContain('logs');
			expect(diff.collections.map(({ collection }) => collection)).toContain('authors');

			// The field rule removes only the one field.
			expect(diff.fields.map(({ field }) => field)).toEqual(['title']);

			// The relation rule removes only the one relation; the other relation still goes through.
			expect(diff.relations.map(({ field }) => field)).toEqual(['log_id']);
		});

		test('filters everything out, so the command reports no changes without writing', async () => {
			const filePath = await writeSnapshot('target.json', JSON.stringify(targetSnapshot()));

			const code = await runApply(filePath, {
				yes: true,
				ignoreRules: 'articles,authors,logs,articles.title,articles.slug,articles.author_id,articles.log_id',
			});

			expect(code).toBe(0);
			expect(mockLogger.info).toHaveBeenCalledWith('No changes to apply.');
			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();
		});
	});

	describe('failure paths', () => {
		test('stops when Directus is not installed and never applies the snapshot', async () => {
			vi.mocked(isInstalled).mockResolvedValue(false);
			const filePath = await writeSnapshot('target.json', JSON.stringify(targetSnapshot()));

			const code = await runApply(filePath, { yes: true });

			// EXISTING CONVENTION (see apply.ts): an uninstalled database exits with status 0, not 1.
			expect(code).toBe(0);
			expect(mockLogger.error).toHaveBeenCalledTimes(1);

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("Directus isn't installed on this database"),
			);

			expect(mockLogger.error.mock.calls[0]![0]).toContain('bootstrap');
			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();
			expect(vi.mocked(getSnapshot)).not.toHaveBeenCalled();
			expect(mockDatabase.destroy).toHaveBeenCalledTimes(1);
		});

		test('logs the error, exits 1 and closes the database when the snapshot file does not exist', async () => {
			const filePath = path.join(tmpdir(), `missing-${Date.now()}-${Math.random()}.json`);

			const code = await runApply(filePath, { yes: true });

			expect(code).toBe(1);
			expect(mockLogger.error).toHaveBeenCalledTimes(1);
			expect(mockLogger.error.mock.calls[0]![0]).toMatchObject({ code: 'ENOENT' });
			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();
			expect(mockDatabase.destroy).toHaveBeenCalledTimes(1);
		});

		test('logs the error, exits 1 and closes the database on malformed JSON', async () => {
			const filePath = await writeSnapshot('broken.json', '{ this is not valid json');

			const code = await runApply(filePath, { yes: true });

			expect(code).toBe(1);
			expect(mockLogger.error).toHaveBeenCalledTimes(1);
			expect(mockLogger.error.mock.calls[0]![0]).toBeInstanceOf(SyntaxError);
			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();
			expect(mockDatabase.destroy).toHaveBeenCalledTimes(1);
		});

		test('logs the error, exits 1 and closes the database on malformed YAML', async () => {
			// Tab indentation is illegal in YAML, so js-yaml throws YAMLException
			const filePath = await writeSnapshot('broken.yaml', 'collections:\n\t- bad');

			const code = await runApply(filePath, { yes: true });

			expect(code).toBe(1);
			expect(mockLogger.error).toHaveBeenCalledTimes(1);
			const error = mockLogger.error.mock.calls[0]![0] as Error;
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe('YAMLException');
			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();
			expect(mockDatabase.destroy).toHaveBeenCalledTimes(1);
		});

		test('logs the error, exits 1 and closes the database when parsed content is not a snapshot', async () => {
			const filePath = await writeSnapshot('not-a-snapshot.json', JSON.stringify({ hello: 'world' }));

			const code = await runApply(filePath, { yes: true });

			expect(code).toBe(1);
			expect(mockLogger.error).toHaveBeenCalledTimes(1);
			expect(mockLogger.error.mock.calls[0]![0]).toBeInstanceOf(TypeError);
			expect(vi.mocked(applySnapshot)).not.toHaveBeenCalled();
			expect(mockDatabase.destroy).toHaveBeenCalledTimes(1);
		});
	});
});
