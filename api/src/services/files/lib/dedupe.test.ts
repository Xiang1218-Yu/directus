import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createMockKnex, resetKnexMocks } from '../../../test-utils/knex.js';
import { createMockDriver } from '../../../test-utils/storage.js';
import {
	BYPASSED_DEDUPE_RESULT,
	countFileReferences,
	createChecksumStream,
	DEDUPE_DEFAULT_ALGORITHM,
	findDedupeCandidate,
	getAvailableFilenameDisk,
	getDedupeAlgorithm,
	hashStoredFile,
	isDedupeEnabled,
} from './dedupe.js';

const state = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));

vi.mock('@directus/env', () => ({ useEnv: () => state.env }));

describe('isDedupeEnabled', () => {
	beforeEach(() => {
		state.env = {};
	});

	test.each(['true', true, '1', 1])('returns true for %p', (value) => {
		state.env = { FILES_DEDUPE_ENABLED: value };
		expect(isDedupeEnabled()).toBe(true);
	});

	test.each(['false', false, '0', 0, undefined])('returns false for %p', (value) => {
		state.env = { FILES_DEDUPE_ENABLED: value };
		expect(isDedupeEnabled()).toBe(false);
	});
});

describe('getDedupeAlgorithm', () => {
	beforeEach(() => {
		state.env = {};
	});

	test('defaults to sha256', () => {
		expect(getDedupeAlgorithm()).toBe(DEDUPE_DEFAULT_ALGORITHM);
	});

	test('uses the configured algorithm', () => {
		state.env = { FILES_DEDUPE_ALGORITHM: 'sha512' };
		expect(getDedupeAlgorithm()).toBe('sha512');
	});

	test('normalizes casing and whitespace', () => {
		state.env = { FILES_DEDUPE_ALGORITHM: ' SHA1 ' };
		expect(getDedupeAlgorithm()).toBe('sha1');
	});

	test('falls back to the default for an unknown algorithm', () => {
		state.env = { FILES_DEDUPE_ALGORITHM: 'not-a-real-algorithm' };
		expect(getDedupeAlgorithm()).toBe(DEDUPE_DEFAULT_ALGORITHM);
	});
});

describe('createChecksumStream', () => {
	test('hashes the content passing through while forwarding it unchanged', async () => {
		const content = Buffer.from('the quick brown fox');
		const checksumStream = createChecksumStream('sha256');

		const forwarded: Buffer[] = [];

		await new Promise<void>((resolve, reject) => {
			Readable.from(content)
				.pipe(checksumStream)
				.on('data', (chunk) => forwarded.push(chunk))
				.on('error', reject)
				.on('finish', () => resolve());
		});

		expect(Buffer.concat(forwarded).equals(content)).toBe(true);
		expect(checksumStream.digest()).toBe(createHash('sha256').update(content).digest('hex'));
	});

	test('digest is null before the stream flushed', () => {
		const checksumStream = createChecksumStream('sha256');
		expect(checksumStream.digest()).toBeNull();
	});

	test('hashes content arriving in many chunks', async () => {
		const chunks = Array.from({ length: 1000 }, (_, index) => Buffer.from(`chunk-${index}`));
		const checksumStream = createChecksumStream('sha256');

		await new Promise<void>((resolve, reject) => {
			Readable.from(chunks)
				.pipe(checksumStream)
				.on('error', reject)
				.on('finish', () => resolve())
				.resume();
		});

		const expected = createHash('sha256');

		for (const chunk of chunks) {
			expected.update(chunk);
		}

		expect(checksumStream.digest()).toBe(expected.digest('hex'));
	});
});

describe('hashStoredFile', () => {
	test('streams the stored file through the hash', async () => {
		const content = Buffer.from('stored file content');
		const driver = createMockDriver();

		vi.mocked(driver.read).mockResolvedValue(Readable.from(content));

		const checksum = await hashStoredFile(driver, 'some-file.txt', 'sha256');

		expect(driver.read).toHaveBeenCalledWith('some-file.txt');
		expect(checksum).toBe(createHash('sha256').update(content).digest('hex'));
	});

	test('rejects when the file cannot be read', async () => {
		const driver = createMockDriver();

		vi.mocked(driver.read).mockRejectedValue(new Error('no such file'));

		await expect(hashStoredFile(driver, 'missing.txt', 'sha256')).rejects.toThrow('no such file');
	});
});

describe('findDedupeCandidate', () => {
	const { db, tracker, mockSchemaBuilder } = createMockKnex();

	beforeEach(() => {
		resetKnexMocks(tracker, mockSchemaBuilder);
	});

	test('queries by storage, checksum and filesize, excluding in-progress uploads', async () => {
		const candidate = { id: 'file-1', filename_disk: 'file-1.jpg', filesize: 100 };

		tracker.on
			.select(
				'select "id", "filename_disk", "filesize" from "directus_files" where "storage" = ? and "checksum" = ? and "filesize" = ? and "tus_id" is null',
			)
			.response([candidate]);

		const result = await findDedupeCandidate(db, {
			storage: 'local',
			checksum: 'abc123',
			filesize: 100,
		});

		expect(result).toEqual(candidate);
	});

	test('excludes the given record ids', async () => {
		tracker.on
			.select(
				'select "id", "filename_disk", "filesize" from "directus_files" where "storage" = ? and "checksum" = ? and "filesize" = ? and "tus_id" is null and "id" not in (?)',
			)
			.response([]);

		const result = await findDedupeCandidate(db, {
			storage: 'local',
			checksum: 'abc123',
			filesize: 100,
			excludeIds: ['file-2'],
		});

		expect(result).toBeNull();
	});

	test('returns null when no candidate exists', async () => {
		tracker.on.select(/directus_files/).response([]);

		const result = await findDedupeCandidate(db, {
			storage: 'local',
			checksum: 'abc123',
			filesize: 100,
		});

		expect(result).toBeNull();
	});
});

describe('countFileReferences', () => {
	const { db, tracker, mockSchemaBuilder } = createMockKnex();

	beforeEach(() => {
		resetKnexMocks(tracker, mockSchemaBuilder);
	});

	test('counts records pointing at the same physical object', async () => {
		tracker.on.select(/count\(\*\).*directus_files/).response([{ count: 2 }]);

		const count = await countFileReferences(db, { storage: 'local', filename_disk: 'shared.jpg' });

		expect(count).toBe(2);
	});

	test('excludes the given record ids', async () => {
		tracker.on.select(/count\(\*\).*directus_files.*not in/).response([{ count: 0 }]);

		const count = await countFileReferences(db, {
			storage: 'local',
			filename_disk: 'shared.jpg',
			excludeIds: ['file-1'],
		});

		expect(count).toBe(0);
	});

	test('returns zero when nothing references the object', async () => {
		tracker.on.select(/directus_files/).response([{ count: 0 }]);

		const count = await countFileReferences(db, { storage: 'local', filename_disk: 'gone.jpg' });

		expect(count).toBe(0);
	});
});

describe('getAvailableFilenameDisk', () => {
	const { db, tracker, mockSchemaBuilder } = createMockKnex();

	beforeEach(() => {
		resetKnexMocks(tracker, mockSchemaBuilder);
	});

	test('returns the plain base name when it is available', async () => {
		tracker.on.select(/directus_files/).response([]);

		const filename = await getAvailableFilenameDisk(db, { base: 'file-1', extension: '.jpg' });

		expect(filename).toBe('file-1.jpg');
	});

	test('returns a suffixed name when the base name is taken', async () => {
		tracker.on.select(/directus_files/).responseOnce([{ filename_disk: 'file-1.jpg' }]);

		tracker.on.select(/directus_files/).response([]);

		const filename = await getAvailableFilenameDisk(db, {
			base: 'file-1',
			extension: '.jpg',
			excludeIds: ['file-1'],
		});

		expect(filename).toMatch(/^file-1_[0-9a-f]{8}\.jpg$/);
	});
});

describe('BYPASSED_DEDUPE_RESULT', () => {
	test('represents a skipped deduplication', () => {
		expect(BYPASSED_DEDUPE_RESULT).toEqual({
			status: 'bypassed',
			algorithm: null,
			checksum: null,
			reusedFrom: null,
		});
	});
});
