import { createHash, getHashes, type Hash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform as TransformStream } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { useEnv } from '@directus/env';
import type { Driver } from '@directus/storage';
import type { File, PrimaryKey } from '@directus/types';
import { toBoolean } from '@directus/utils';
import type { Knex } from 'knex';

/**
 * Content-addressed deduplication for file uploads.
 *
 * When enabled (`FILES_DEDUPE_ENABLED=true`), every upload is hashed while it streams to
 * storage. If another (completed) file record in the same project and storage location
 * already points at an object with the same content, the new record reuses that physical
 * object instead of storing a second copy. Records keep their own row in `directus_files`,
 * so metadata stays independent while the bytes on disk are shared.
 *
 * Physical objects are only ever deleted once no record references them anymore
 * (see `countFileReferences`).
 */

export const DEDUPE_DEFAULT_ALGORITHM = 'sha256';

export type DedupeStatus =
	/** The physical object already existed and is now shared with another record */
	| 'reused'
	/** No matching object existed, the uploaded bytes were stored as a new object */
	| 'stored'
	/** Deduplication is disabled or was skipped (e.g. replacements keep their own object) */
	| 'bypassed'
	/** Deduplication failed and the upload fell back to storing a new object */
	| 'failed';

export type DedupeResult = {
	status: DedupeStatus;
	algorithm: string | null;
	checksum: string | null;
	/** Id of the file record whose physical object is being reused (status `reused` only) */
	reusedFrom: PrimaryKey | null;
};

export const BYPASSED_DEDUPE_RESULT: DedupeResult = {
	status: 'bypassed',
	algorithm: null,
	checksum: null,
	reusedFrom: null,
};

export function isDedupeEnabled(): boolean {
	const env = useEnv();
	return toBoolean(env['FILES_DEDUPE_ENABLED']);
}

export function getDedupeAlgorithm(): string {
	const env = useEnv();

	const algorithm = String(env['FILES_DEDUPE_ALGORITHM'] ?? DEDUPE_DEFAULT_ALGORITHM)
		.trim()
		.toLowerCase();

	// Guard against typos in the configured algorithm: unknown algorithms would make every
	// upload fail, so fall back to the default instead
	if (getHashes().includes(algorithm) === false) {
		return DEDUPE_DEFAULT_ALGORITHM;
	}

	return algorithm;
}

export type ChecksumStream = TransformStream & {
	/** Hex digest of everything that passed through the stream. `null` until the stream flushed. */
	digest: () => string | null;
};

/**
 * Transform stream that hashes everything passing through it. Piping the upload through
 * this stream keeps memory usage constant regardless of file size.
 */
export function createChecksumStream(algorithm: string): ChecksumStream {
	const hash: Hash = createHash(algorithm);

	let hexDigest: string | null = null;

	const stream = new TransformStream({
		transform(chunk, _encoding, callback) {
			hash.update(chunk);
			callback(null, chunk);
		},
		flush(callback) {
			hexDigest = hash.digest('hex');
			callback();
		},
	}) as ChecksumStream;

	stream.digest = () => hexDigest;

	return stream;
}

/**
 * Hash a file that already exists in storage by streaming it back in. Used for content
 * that never passed through the API in one piece (TUS/chunked uploads) and for backfilling
 * checksums of files that were uploaded before deduplication was enabled.
 */
export async function hashStoredFile(disk: Driver, filepath: string, algorithm: string): Promise<string> {
	const checksumStream = createChecksumStream(algorithm);
	const readStream: Readable = await disk.read(filepath);

	await pipeline(readStream, checksumStream);

	const checksum = checksumStream.digest();

	if (checksum === null) {
		throw new Error(`Couldn't calculate checksum for "${filepath}"`);
	}

	return checksum;
}

export type DedupeCandidate = Pick<File, 'id' | 'filename_disk' | 'filesize'>;

/**
 * Find an existing file record whose physical object can be reused for the given content.
 *
 * Candidates are scoped to the current project (tenant) and storage location, and must
 * match on both checksum and filesize to guard against digest collisions. Only completed
 * uploads qualify (in-progress TUS uploads are excluded), and files uploaded before
 * deduplication was enabled simply have no checksum and therefore never match.
 */
export async function findDedupeCandidate(
	knex: Knex,
	options: { storage: string; checksum: string; filesize: number; excludeIds?: PrimaryKey[] },
): Promise<DedupeCandidate | null> {
	const query = knex
		.select('id', 'filename_disk', 'filesize')
		.from('directus_files')
		.where({
			storage: options.storage,
			checksum: options.checksum,
			filesize: options.filesize,
		})
		.whereNull('tus_id')
		.orderBy('uploaded_on', 'asc')
		.first();

	if (options.excludeIds && options.excludeIds.length > 0) {
		query.whereNotIn('id', options.excludeIds);
	}

	const candidate = await query;

	return candidate ?? null;
}

/**
 * Count how many file records reference a physical object, optionally excluding records
 * that are about to be deleted or updated. Physical objects may only be deleted from
 * storage when this reaches zero.
 */
export async function countFileReferences(
	knex: Knex,
	options: { storage: string; filename_disk: string; excludeIds?: PrimaryKey[] },
): Promise<number> {
	const query = knex
		.count('*', { as: 'count' })
		.from('directus_files')
		.where({ storage: options.storage, filename_disk: options.filename_disk });

	if (options.excludeIds && options.excludeIds.length > 0) {
		query.whereNotIn('id', options.excludeIds);
	}

	const result = await query.first();

	return Number(result?.['count'] ?? 0);
}

/**
 * Find an unused filename on disk, derived from the given base name. Used when a record
 * needs its own physical object (e.g. replacing the content of a deduplicated file whose
 * object is shared with other records) and the preferred name is already taken.
 */
export async function getAvailableFilenameDisk(
	knex: Knex,
	options: { base: string; extension: string; excludeIds?: PrimaryKey[] },
): Promise<string> {
	const isTaken = async (filename: string): Promise<boolean> => {
		const query = knex.select('filename_disk').from('directus_files').where({ filename_disk: filename });

		if (options.excludeIds && options.excludeIds.length > 0) {
			query.whereNotIn('id', options.excludeIds);
		}

		return Boolean(await query.first());
	};

	let filename = `${options.base}${options.extension}`;

	while (await isTaken(filename)) {
		filename = `${options.base}_${randomUUID().slice(0, 8)}${options.extension}`;
	}

	return filename;
}
