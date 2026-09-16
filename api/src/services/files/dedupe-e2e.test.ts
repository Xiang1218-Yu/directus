/**
 * End-to-end behavior tests for content-addressed file deduplication.
 *
 * These tests run the real FilesService and TusDataStore against a real (in-memory
 * SQLite) database and a real local storage driver in a temporary directory, covering
 * the full upload → dedupe → replace → delete lifecycle.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FieldOverview, SchemaOverview } from '@directus/types';
import type { Upload } from '@tus/utils';
import type { Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { getStorage } from '../../storage/index.js';
import { FilesService } from '../files.js';
import { TusDataStore } from '../tus/data-store.js';

const testContext = await vi.hoisted(async () => {
	const { mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { default: knex } = await import('knex');

	const storageRoot = mkdtempSync(join(tmpdir(), 'directus-dedupe-e2e-'));
	const secondaryStorageRoot = mkdtempSync(join(tmpdir(), 'directus-dedupe-e2e-secondary-'));

	// A file-backed database: with SQLite every pooled connection gets its own
	// separate in-memory database, and transactions pin a connection, so ':memory:'
	// would both hide tables and deadlock nested queries
	const dbFilename = join(mkdtempSync(join(tmpdir(), 'directus-dedupe-e2e-db-')), 'test.db');

	const envBackup: Record<string, string | undefined> = {};

	const env = {
		DB_CLIENT: 'sqlite3',
		DB_FILENAME: dbFilename,
		STORAGE_LOCATIONS: 'local,secondary',
		STORAGE_LOCAL_DRIVER: 'local',
		STORAGE_LOCAL_ROOT: storageRoot,
		STORAGE_SECONDARY_DRIVER: 'local',
		STORAGE_SECONDARY_ROOT: secondaryStorageRoot,
		FILES_DEDUPE_ENABLED: 'true',
		FILES_DEDUPE_ALGORITHM: 'sha256',
		CACHE_ENABLED: 'false',
		LOG_LEVEL: 'silent',
	} as const;

	for (const [key, value] of Object.entries(env)) {
		envBackup[key] = process.env[key];
		process.env[key] = value;
	}

	// A real SQLite database, mirroring the configuration getDatabase() uses
	const db = knex({
		client: 'sqlite3',
		connection: { filename: dbFilename },
		useNullAsDefault: true,
	});

	return { storageRoot, secondaryStorageRoot, envBackup, db };
});

// Route the (real) database module at the in-memory test database. Everything else in
// the module (getDatabaseClient, helpers, ...) stays real.
vi.mock('../../database/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../database/index.js')>();

	return {
		...actual,
		default: vi.fn(() => testContext.db),
	};
});

function makeField(field: string, type: FieldOverview['type'], overrides: Partial<FieldOverview> = {}): FieldOverview {
	return {
		field,
		type,
		dbType: null,
		nullable: true,
		generated: false,
		defaultValue: null,
		alias: false,
		validation: null,
		special: [],
		note: null,
		precision: null,
		scale: null,
		searchable: false,
		...overrides,
	};
}

const schema: SchemaOverview = {
	collections: {
		directus_files: {
			collection: 'directus_files',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: makeField('id', 'uuid', { special: ['uuid'], nullable: false }),
				storage: makeField('storage', 'string'),
				filename_disk: makeField('filename_disk', 'string'),
				filename_download: makeField('filename_download', 'string'),
				title: makeField('title', 'string'),
				type: makeField('type', 'string'),
				folder: makeField('folder', 'uuid'),
				created_on: makeField('created_on', 'dateTime', { special: ['date-created'] }),
				uploaded_by: makeField('uploaded_by', 'uuid', { special: ['user-created'] }),
				uploaded_on: makeField('uploaded_on', 'dateTime'),
				modified_by: makeField('modified_by', 'uuid', { special: ['user-updated'] }),
				modified_on: makeField('modified_on', 'dateTime', { special: ['date-created', 'date-updated'] }),
				charset: makeField('charset', 'string'),
				filesize: makeField('filesize', 'bigInteger'),
				width: makeField('width', 'integer'),
				height: makeField('height', 'integer'),
				duration: makeField('duration', 'integer'),
				embed: makeField('embed', 'string'),
				description: makeField('description', 'text'),
				location: makeField('location', 'string'),
				tags: makeField('tags', 'json', { special: ['cast-json'] }),
				metadata: makeField('metadata', 'json', { special: ['cast-json'] }),
				focal_point_x: makeField('focal_point_x', 'integer'),
				focal_point_y: makeField('focal_point_y', 'integer'),
				tus_id: makeField('tus_id', 'string'),
				tus_data: makeField('tus_data', 'json', { special: ['cast-json'] }),
				checksum: makeField('checksum', 'string'),
			},
		},
		directus_settings: {
			collection: 'directus_settings',
			primary: 'id',
			singleton: true,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: makeField('id', 'integer'),
				storage_default_folder: makeField('storage_default_folder', 'uuid'),
			},
		},
	},
	relations: [],
};

const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

describe('Files deduplication (e2e)', () => {
	let db: Knex;
	let service: FilesService;

	beforeAll(async () => {
		db = testContext.db;

		await db.schema.createTable('directus_files', (table) => {
			table.string('id', 36).primary();
			table.string('storage').notNullable();
			table.string('filename_disk').nullable();
			table.string('filename_download').nullable();
			table.string('title').nullable();
			table.string('type').nullable();
			table.string('folder', 36).nullable();
			table.dateTime('created_on').nullable();
			table.string('uploaded_by', 36).nullable();
			table.dateTime('uploaded_on').nullable();
			table.string('modified_by', 36).nullable();
			table.dateTime('modified_on').nullable();
			table.string('charset').nullable();
			table.bigInteger('filesize').nullable();
			table.integer('width').nullable();
			table.integer('height').nullable();
			table.integer('duration').nullable();
			table.string('embed').nullable();
			table.text('description').nullable();
			table.string('location').nullable();
			table.text('tags').nullable();
			table.text('metadata').nullable();
			table.integer('focal_point_x').nullable();
			table.integer('focal_point_y').nullable();
			table.string('tus_id', 64).nullable();
			table.text('tus_data').nullable();
			table.string('checksum', 128).nullable();
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.string('storage_default_folder', 36).nullable();
		});

		service = new FilesService({ knex: db, schema, accountability: null });
	});

	afterAll(async () => {
		await db.destroy();
		rmSync(testContext.storageRoot, { recursive: true, force: true });
		rmSync(testContext.secondaryStorageRoot, { recursive: true, force: true });

		for (const [key, value] of Object.entries(testContext.envBackup)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	const readRecord = (id: string) => db.select('*').from('directus_files').where({ id }).first();

	const storedFiles = () => readdirSync(testContext.storageRoot);

	test('identical uploads share one physical object, which lives until the last reference is deleted', async () => {
		const content = 'the rain in spain stays mainly in the plain';

		const dedupeResults: any[] = [];

		const idA = (await service.uploadOne(
			Readable.from(Buffer.from(content)),
			{ filename_download: 'a.txt', type: 'text/plain' },
			undefined,
			{ onDedupeResult: (result) => dedupeResults.push(result) },
		)) as string;

		const idB = (await service.uploadOne(
			Readable.from(Buffer.from(content)),
			{ filename_download: 'b.txt', type: 'text/plain' },
			undefined,
			{ onDedupeResult: (result) => dedupeResults.push(result) },
		)) as string;

		expect(idA).not.toBe(idB);

		const recordA = await readRecord(idA);
		const recordB = await readRecord(idB);

		// Both records carry the checksum of the content
		expect(recordA['checksum']).toBe(sha256(content));
		expect(recordB['checksum']).toBe(sha256(content));

		// The second upload reuses the physical object of the first
		expect(recordA['filename_disk']).toBe(`${idA}.txt`);
		expect(recordB['filename_disk']).toBe(`${idA}.txt`);

		// Only one physical object exists
		expect(storedFiles().sort()).toEqual([`${idA}.txt`]);
		expect(readFileSync(join(testContext.storageRoot, `${idA}.txt`), 'utf8')).toBe(content);

		// The dedupe outcomes are observable
		expect(dedupeResults).toEqual([
			expect.objectContaining({ status: 'stored', checksum: sha256(content) }),
			expect.objectContaining({ status: 'reused', checksum: sha256(content), reusedFrom: idA }),
		]);

		// Deleting the first record keeps the physical object: the second record still uses it
		await service.deleteMany([idA]);

		expect(await readRecord(idA)).toBeUndefined();
		expect(existsSync(join(testContext.storageRoot, `${idA}.txt`))).toBe(true);

		// Deleting the last reference removes the physical object
		await service.deleteMany([idB]);

		expect(await readRecord(idB)).toBeUndefined();
		expect(existsSync(join(testContext.storageRoot, `${idA}.txt`))).toBe(false);
		expect(storedFiles()).toEqual([]);
	});

	test('distinct content is stored as separate objects', async () => {
		const idA = (await service.uploadOne(Readable.from(Buffer.from('content-a')), {
			filename_download: 'a.txt',
			type: 'text/plain',
		})) as string;

		const idB = (await service.uploadOne(Readable.from(Buffer.from('content-b')), {
			filename_download: 'b.txt',
			type: 'text/plain',
		})) as string;

		const recordA = await readRecord(idA);
		const recordB = await readRecord(idB);

		expect(recordA['filename_disk']).not.toBe(recordB['filename_disk']);
		expect(recordA['checksum']).not.toBe(recordB['checksum']);
		expect(storedFiles().sort()).toEqual([`${idA}.txt`, `${idB}.txt`].sort());

		await service.deleteMany([idA, idB]);
	});

	test('replacing a deduplicated file leaves the shared object intact for the other record', async () => {
		const shared = 'shared content';
		const replacement = 'replacement content';

		const idA = (await service.uploadOne(Readable.from(Buffer.from(shared)), {
			filename_download: 'a.txt',
			type: 'text/plain',
		})) as string;

		const idB = (await service.uploadOne(Readable.from(Buffer.from(shared)), {
			filename_download: 'b.txt',
			type: 'text/plain',
		})) as string;

		// Sanity: both records share the object named after the first record
		expect((await readRecord(idB))['filename_disk']).toBe(`${idA}.txt`);

		// Replace the content of the first record
		await service.uploadOne(
			Readable.from(Buffer.from(replacement)),
			{ filename_download: 'a-new.txt', type: 'text/plain' },
			idA,
		);

		const recordA = await readRecord(idA);
		const recordB = await readRecord(idB);

		// The replaced record got its own fresh object; the shared object is untouched
		expect(recordA['filename_disk']).not.toBe(`${idA}.txt`);
		expect(recordA['checksum']).toBe(sha256(replacement));

		expect(recordB['filename_disk']).toBe(`${idA}.txt`);
		expect(recordB['checksum']).toBe(sha256(shared));

		expect(readFileSync(join(testContext.storageRoot, `${idA}.txt`), 'utf8')).toBe(shared);
		expect(readFileSync(join(testContext.storageRoot, recordA['filename_disk']), 'utf8')).toBe(replacement);

		await service.deleteMany([idA, idB]);
	});

	test('replacing content with an identical existing object reuses it and cleans up the old one', async () => {
		const contentA = 'content-a';
		const contentB = 'content-b';

		const idA = (await service.uploadOne(Readable.from(Buffer.from(contentA)), {
			filename_download: 'a.txt',
			type: 'text/plain',
		})) as string;

		const idB = (await service.uploadOne(Readable.from(Buffer.from(contentB)), {
			filename_download: 'b.txt',
			type: 'text/plain',
		})) as string;

		expect(storedFiles().sort()).toEqual([`${idA}.txt`, `${idB}.txt`].sort());

		// Replace the second file with the content of the first
		await service.uploadOne(
			Readable.from(Buffer.from(contentA)),
			{ filename_download: 'b.txt', type: 'text/plain' },
			idB,
		);

		const recordB = await readRecord(idB);

		// The record now points at the first file's object; its own previous object is gone
		expect(recordB['filename_disk']).toBe(`${idA}.txt`);
		expect(recordB['checksum']).toBe(sha256(contentA));

		expect(storedFiles()).toEqual([`${idA}.txt`]);

		await service.deleteMany([idA, idB]);
	});

	test('chunked (TUS) uploads are deduplicated against existing objects', async () => {
		const content = 'chunked upload content';

		// Upload the content once through the regular flow
		const existingId = (await service.uploadOne(Readable.from(Buffer.from(content)), {
			filename_download: 'existing.txt',
			type: 'text/plain',
		})) as string;

		const storage = await getStorage();
		const driver = storage.location('local');

		const store = new TusDataStore({
			constants: { ENABLED: true, CHUNK_SIZE: null, EXPIRATION_TIME: 0, SCHEDULE: '' },
			location: 'local',
			driver: driver as any,
			schema,
			accountability: undefined,
		});

		const upload = {
			id: 'tus-upload-1',
			size: content.length,
			offset: 0,
			metadata: { filename_download: 'chunked.txt', type: 'text/plain' },
		} as unknown as Upload;

		// Create the chunked upload and push the content in two chunks
		await store.create(upload);

		const halfway = Math.floor(content.length / 2);

		const offsetAfterFirstChunk = await store.write(
			Readable.from(Buffer.from(content.slice(0, halfway))),
			upload.id,
			0,
		);

		const finalOffset = await store.write(
			Readable.from(Buffer.from(content.slice(halfway))),
			upload.id,
			offsetAfterFirstChunk,
		);

		expect(finalOffset).toBe(content.length);

		const placeholder = (await db.select('*').from('directus_files').where({ tus_id: upload.id }).first())!;

		// The placeholder record points at the existing physical object
		expect(placeholder['filename_disk']).toBe(`${existingId}.txt`);
		expect(placeholder['checksum']).toBe(sha256(content));

		// The assembled copy was discarded; only the shared object remains
		expect(storedFiles()).toEqual([`${existingId}.txt`]);

		// Simulate the onUploadFinish hook clearing the TUS bookkeeping
		await db('directus_files').update({ tus_id: null, tus_data: null }).where({ id: placeholder['id'] });

		await service.deleteMany([existingId, placeholder['id']]);
	});

	test('chunked (TUS) upload of new content stores the object and records its checksum', async () => {
		const content = 'brand new chunked content';

		const storage = await getStorage();
		const driver = storage.location('local');

		const store = new TusDataStore({
			constants: { ENABLED: true, CHUNK_SIZE: null, EXPIRATION_TIME: 0, SCHEDULE: '' },
			location: 'local',
			driver: driver as any,
			schema,
			accountability: undefined,
		});

		const upload = {
			id: 'tus-upload-2',
			size: content.length,
			offset: 0,
			metadata: { filename_download: 'new-chunked.txt', type: 'text/plain' },
		} as unknown as Upload;

		await store.create(upload);

		const finalOffset = await store.write(Readable.from(Buffer.from(content)), upload.id, 0);

		expect(finalOffset).toBe(content.length);

		const placeholder = (await db.select('*').from('directus_files').where({ tus_id: upload.id }).first())!;

		expect(placeholder['filename_disk']).toBe(`${placeholder['id']}.txt`);
		expect(placeholder['checksum']).toBe(sha256(content));

		expect(readFileSync(join(testContext.storageRoot, `${placeholder['id']}.txt`), 'utf8')).toBe(content);

		await db('directus_files').update({ tus_id: null, tus_data: null }).where({ id: placeholder['id'] });

		await service.deleteMany([placeholder['id']]);
	});

	test('identical content in different storage locations is not deduplicated across locations', async () => {
		const content = 'same content, different locations';

		const idLocal = (await service.uploadOne(Readable.from(Buffer.from(content)), {
			filename_download: 'local.txt',
			type: 'text/plain',
		})) as string;

		const idSecondary = (await service.uploadOne(Readable.from(Buffer.from(content)), {
			storage: 'secondary',
			filename_download: 'secondary.txt',
			type: 'text/plain',
		} as any)) as string;

		const recordLocal = await readRecord(idLocal);
		const recordSecondary = await readRecord(idSecondary);

		// Both records carry the checksum, but each location keeps its own physical object
		expect(recordLocal['checksum']).toBe(sha256(content));
		expect(recordSecondary['checksum']).toBe(sha256(content));

		expect(recordLocal['filename_disk']).toBe(`${idLocal}.txt`);
		expect(recordSecondary['filename_disk']).toBe(`${idSecondary}.txt`);

		expect(readFileSync(join(testContext.storageRoot, `${idLocal}.txt`), 'utf8')).toBe(content);
		expect(readFileSync(join(testContext.secondaryStorageRoot, `${idSecondary}.txt`), 'utf8')).toBe(content);

		// Deleting the local file must not touch the secondary location's object
		await service.deleteMany([idLocal]);

		expect(existsSync(join(testContext.secondaryStorageRoot, `${idSecondary}.txt`))).toBe(true);

		await service.deleteMany([idSecondary]);
	});

	test('replacing a file with dedupe disabled clears the stale checksum', async () => {
		const { useEnv } = await import('@directus/env');
		const env = useEnv();

		const id = (await service.uploadOne(Readable.from(Buffer.from('original content')), {
			filename_download: 'file.txt',
			type: 'text/plain',
		})) as string;

		expect((await readRecord(id))['checksum']).toBe(sha256('original content'));

		(env as Record<string, unknown>)['FILES_DEDUPE_ENABLED'] = false;

		try {
			await service.uploadOne(
				Readable.from(Buffer.from('replaced content')),
				{ filename_download: 'file.txt', type: 'text/plain' },
				id,
			);
		} finally {
			(env as Record<string, unknown>)['FILES_DEDUPE_ENABLED'] = true;
		}

		// The record no longer claims a checksum its content doesn't match
		expect((await readRecord(id))['checksum']).toBeNull();

		await service.deleteMany([id]);
	});
});
