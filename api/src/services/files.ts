import type { Readable } from 'node:stream';
import { PassThrough as PassThroughStream, Transform as TransformStream } from 'node:stream';
import zlib from 'node:zlib';
import path from 'path';
import url from 'url';
import { useEnv } from '@directus/env';
import {
	ContentTooLargeError,
	InternalServerError,
	InvalidPayloadError,
	ServiceUnavailableError,
} from '@directus/errors';
import formatTitle from '@directus/format-title';
import type {
	AbstractServiceOptions,
	BusboyFileStream,
	File,
	MutationOptions,
	PrimaryKey,
	Query,
	QueryOptions,
} from '@directus/types';
import { normalizePath, toArray, toBoolean } from '@directus/utils';
import type { AxiosResponse } from 'axios';
import encodeURL from 'encodeurl';
import { clone, cloneDeep } from 'lodash-es';
import { extension } from 'mime-types';
import { RESUMABLE_UPLOADS } from '../constants.js';
import emitter from '../emitter.js';
import { useLogger } from '../logger/index.js';
import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
import { getAxios } from '../request/index.js';
import { getStorage } from '../storage/index.js';
import { transaction } from '../utils/transaction.js';
import { assertUniqueFilename } from './files/lib/assert-unique-filename.js';
import { assertValidStoragePath } from './files/lib/assert-valid-storage-path.js';
import {
	BYPASSED_DEDUPE_RESULT,
	type ChecksumStream,
	countFileReferences,
	createChecksumStream,
	type DedupeResult,
	findDedupeCandidate,
	getAvailableFilenameDisk,
	getDedupeAlgorithm,
	isDedupeEnabled,
} from './files/lib/dedupe.js';
import { extractMetadata } from './files/lib/extract-metadata.js';
import { isMimeTypeAllowed } from './files/lib/is-mime-type-allowed.js';
import { sanitizeFilepath } from './files/lib/sanitize-filepath.js';
import { ItemsService } from './items.js';

const env = useEnv();
const logger = useLogger();

export type UploadOneOptions = MutationOptions & {
	/**
	 * Callback that receives the deduplication outcome of the upload, allowing callers
	 * (e.g. the API controller) to observe whether the physical file was reused or stored
	 */
	onDedupeResult?: (result: DedupeResult) => void;
};

export class FilesService extends ItemsService<File> {
	constructor(options: AbstractServiceOptions) {
		super('directus_files', options);
	}

	/**
	 * Upload a single new file to the configured storage adapter
	 */
	async uploadOne(
		stream: BusboyFileStream | Readable,
		data: Partial<File>,
		primaryKey?: PrimaryKey,
		opts?: UploadOneOptions,
	): Promise<PrimaryKey> {
		const storage = await getStorage();

		const dedupeEnabled = isDedupeEnabled();
		const dedupeAlgorithm = dedupeEnabled ? getDedupeAlgorithm() : null;

		const dedupeResult: DedupeResult = { ...BYPASSED_DEDUPE_RESULT };

		let existingFile: Record<string, any> | null = null;

		// If the payload contains a primary key, we'll check if the file already exists
		if (primaryKey !== undefined) {
			// If the file you're uploading already exists, we'll consider this upload a replace so we'll fetch the existing file's folder and filename_download
			existingFile =
				(await this.knex
					.select('folder', 'filename_download', 'filename_disk', 'title', 'description', 'metadata', 'storage')
					.from('directus_files')
					.where({ id: primaryKey })
					.first()) ?? null;
		}

		// Merge the existing file's folder and filename_download with the new payload
		const payload = {
			storage: toArray(env['STORAGE_LOCATIONS'] as string)[0]!,
			...(existingFile ?? {}),
			...clone(data),
		};

		const disk = storage.location(payload.storage);

		// If no folder is specified, we'll use the default folder from the settings if it exists
		if ('folder' in payload === false) {
			const settings = await this.knex.select('storage_default_folder').from('directus_settings').first();

			if (settings?.storage_default_folder) {
				payload.folder = settings.storage_default_folder;
			}
		}

		// Is this file a replacement? if the file data already exists and we have a primary key
		const isReplacement = existingFile !== null && primaryKey !== undefined;

		// If this is a new file upload, we need to generate a new primary key and DB record
		if (isReplacement === false || primaryKey === undefined) {
			primaryKey = await this.createOne(payload, { emitEvents: false });
		}

		const fileExtension =
			path.extname(payload.filename_download!) || (payload.type && '.' + extension(payload.type)) || '';

		const filenameDisk = primaryKey + (fileExtension || '');

		// The filename_disk is the FINAL filename on disk
		payload.filename_disk ||= filenameDisk;

		// If the filename_disk extension doesn't match the new mimetype, update it
		if (isReplacement === true && path.extname(payload.filename_disk!) !== fileExtension) {
			payload.filename_disk = filenameDisk;
		}

		// Temp filename is used for replacements
		const tempFilenameDisk = 'temp_' + filenameDisk;

		if (!payload.type) {
			payload.type = 'application/octet-stream';
		}

		// An explicitly requested filename_disk on a new upload is a deliberate naming choice,
		// so such uploads keep their own physical object instead of reusing an existing one
		const allowDedupeReuse = dedupeEnabled && (isReplacement || !data.filename_disk);

		// Whether the temp file (used for replacements) was already consumed by the dedupe logic
		let tempFileConsumed = false;

		// Used to clean up if something goes wrong
		const cleanUp = async () => {
			try {
				if (isReplacement === true) {
					// If this is a replacement that failed, we need to delete the temp file
					if (tempFileConsumed === false) {
						await disk.delete(tempFilenameDisk);
					}
				} else {
					// If this is a new file that failed
					// delete the DB record
					await super.deleteMany([primaryKey!]);

					// Delete the final file, unless the record was pointed at a physical object
					// that's shared with (and still used by) another file record
					if (dedupeResult.status !== 'reused') {
						await disk.delete(payload.filename_disk!);
					}
				}
			} catch (err: any) {
				if (isReplacement === true) {
					logger.warn(`Couldn't delete temp file ${tempFilenameDisk}`);
				} else {
					logger.warn(`Couldn't delete file ${payload.filename_disk}`);
				}

				logger.warn(err);
			}
		};

		// Hash the upload while it streams to storage, keeping memory usage flat for large files
		let checksumStream: ChecksumStream | null = null;
		let writeContent: BusboyFileStream | Readable = stream;

		if (dedupeEnabled && dedupeAlgorithm) {
			checksumStream = createChecksumStream(dedupeAlgorithm);
			writeContent = stream.compose(checksumStream);
		}

		try {
			// If this is a replacement, we'll write the file to a temp location first to ensure we don't overwrite the existing file if something goes wrong
			if (isReplacement === true) {
				await disk.write(tempFilenameDisk, writeContent, payload.type);
			} else {
				// If this is a new file upload, we'll write the file to the final location
				await disk.write(payload.filename_disk, writeContent, payload.type);
			}

			// Check if the file was truncated (if the stream ended early) and throw limit error if it was
			if ('truncated' in stream && stream.truncated === true) {
				throw new ContentTooLargeError();
			}
		} catch (err: any) {
			logger.warn(`Couldn't save file ${payload.filename_disk}`);
			logger.warn(err);

			await cleanUp();

			if (err instanceof ContentTooLargeError) {
				throw err;
			} else if (err?.code && ['EROFS', 'EACCES', 'EPERM'].includes(err.code)) {
				throw new InternalServerError();
			} else {
				throw new ServiceUnavailableError({ service: 'files', reason: `Couldn't save file ${payload.filename_disk}` });
			}
		}

		if (checksumStream && dedupeAlgorithm) {
			try {
				const checksum = checksumStream.digest();

				if (checksum) {
					payload.checksum = checksum;
					dedupeResult.algorithm = dedupeAlgorithm;
					dedupeResult.checksum = checksum;

					if (allowDedupeReuse) {
						const writtenFilepath = isReplacement ? tempFilenameDisk : payload.filename_disk!;
						const { size } = await disk.stat(writtenFilepath);

						// Matching on checksum and filesize within the same storage location guards
						// against digest collisions before a physical object is reused
						const candidate = await findDedupeCandidate(this.knex, {
							storage: payload.storage,
							checksum,
							filesize: size,
							excludeIds: [primaryKey!],
						});

						// The candidate's object has to still exist in storage; a stale database
						// row is not a valid reuse target
						if (candidate && (await disk.exists(candidate.filename_disk))) {
							// Drop the copy that was just written and point the record at the shared object
							await disk.delete(writtenFilepath);

							if (isReplacement) tempFileConsumed = true;

							payload.filename_disk = candidate.filename_disk;
							dedupeResult.status = 'reused';
							dedupeResult.reusedFrom = candidate.id;
						} else {
							if (candidate) {
								logger.info(
									`Physical file ${candidate.filename_disk} for dedupe candidate ${candidate.id} no longer exists, storing upload as a new file`,
								);
							}

							dedupeResult.status = 'stored';
						}
					} else {
						dedupeResult.status = 'stored';
					}
				}
			} catch (err: any) {
				// Deduplication must never break an upload; fall back to keeping the newly stored file
				logger.warn(`Couldn't deduplicate the uploaded file, storing it as a new file`);
				logger.warn(err);
				dedupeResult.status = 'failed';
			}
		}

		// A replacement without a freshly computed checksum (dedupe disabled or failed)
		// invalidates the checksum the record carried before; keeping it would let future
		// dedupe runs match against content the file no longer holds
		if (isReplacement === true && dedupeResult.checksum === null) {
			payload.checksum = null;
		}

		// If the file is a replacement, we need to update the DB record with the new payload, delete the old files, and upgrade the temp file
		if (isReplacement === true) {
			try {
				if (dedupeResult.status === 'reused') {
					// The temp file was already discarded above and the record now points at the
					// shared object. The shared filename_disk intentionally belongs to another
					// record as well, which FilesService.updateMany would reject as non-unique,
					// so this update goes through the sudo service.
					const sudoFilesItemsService = new ItemsService('directus_files', {
						knex: this.knex,
						schema: this.schema,
					});

					await sudoFilesItemsService.updateOne(primaryKey, payload, { emitEvents: false });

					// Remove the replaced physical object once no record references it anymore
					await this.deleteFileIfUnreferenced(payload.storage, existingFile!['filename_disk']);
				} else {
					const oldFilenameDisk = existingFile!['filename_disk'] as string;

					// The previous physical object may be shared with other records when earlier
					// uploads were deduplicated. In that case it must stay untouched, and the new
					// content is stored under a fresh name instead of overwriting the shared object.
					const oldFileIsShared = await this.isFileShared(payload.storage, oldFilenameDisk, primaryKey);

					if (oldFileIsShared) {
						payload.filename_disk = await getAvailableFilenameDisk(this.knex, {
							base: String(primaryKey),
							extension: fileExtension,
							excludeIds: [primaryKey],
						});

						await this.updateOne(primaryKey, payload, { emitEvents: false });

						// Upgrade the temp file to the fresh filename
						await disk.move(tempFilenameDisk, payload.filename_disk);
					} else {
						await this.updateOne(primaryKey, payload, { emitEvents: false });

						// delete the previously saved file and thumbnails to ensure they're generated fresh
						for await (const filepath of disk.list(String(primaryKey))) {
							await disk.delete(filepath);
						}

						// Upgrade the temp file to the final filename
						await disk.move(tempFilenameDisk, payload.filename_disk);
					}

					tempFileConsumed = true;
				}
			} catch (err: any) {
				await cleanUp();
				throw err;
			}
		}

		const { size } = await storage.location(payload.storage).stat(payload.filename_disk);
		payload.filesize = size;

		const metadata = await extractMetadata(payload.storage, payload as Parameters<typeof extractMetadata>[1]);

		payload.uploaded_on = new Date().toISOString();

		// We do this in a service without accountability. Even if you don't have update permissions to the file,
		// we still want to be able to set the extracted values from the file on create
		const sudoFilesItemsService = new ItemsService('directus_files', {
			knex: this.knex,
			schema: this.schema,
		});

		await sudoFilesItemsService.updateOne(primaryKey, { ...payload, ...metadata }, { emitEvents: false });

		opts?.onDedupeResult?.(dedupeResult);

		if (opts?.emitEvents !== false) {
			emitter.emitAction(
				'files.upload',
				{
					payload,
					key: primaryKey,
					collection: this.collection,
					dedupe: dedupeResult,
				},
				{
					database: this.knex,
					schema: this.schema,
					accountability: this.accountability,
				},
			);
		}

		return primaryKey;
	}

	/**
	 * Whether a physical object is referenced by any file record other than the given one.
	 * Shared objects exist when uploads were deduplicated; they must never be overwritten
	 * or deleted while another record still points at them.
	 */
	private async isFileShared(storage: string, filenameDisk: string, excludeId: PrimaryKey): Promise<boolean> {
		const references = await countFileReferences(this.knex, {
			storage,
			filename_disk: filenameDisk,
			excludeIds: [excludeId],
		});

		return references > 0;
	}

	/**
	 * Delete a physical object and its generated assets from storage, but only when no
	 * file record references it anymore. Shared objects are left untouched.
	 */
	private async deleteFileIfUnreferenced(storageLocation: string, filenameDisk: string): Promise<void> {
		const references = await countFileReferences(this.knex, {
			storage: storageLocation,
			filename_disk: filenameDisk,
		});

		if (references > 0) return;

		const storage = await getStorage();
		const disk = storage.location(storageLocation);
		const filePrefix = path.parse(filenameDisk).name;

		// Delete file + thumbnails
		for await (const filepath of disk.list(filePrefix)) {
			await disk.delete(filepath);
		}
	}

	/**
	 * Extract metadata from a buffer's content
	 */

	/**
	 * Import a single file from an external URL
	 */
	async importOne(
		importURL: string,
		body: Partial<File>,
		options: { filterMimeType?: string[] } = {},
	): Promise<PrimaryKey> {
		if (this.accountability) {
			await validateAccess(
				{
					accountability: this.accountability,
					action: 'create',
					collection: 'directus_files',
				},
				{
					knex: this.knex,
					schema: this.schema,
				},
			);
		}

		let fileResponse;

		try {
			const axios = await getAxios();

			fileResponse = await axios.get<Readable>(encodeURL(importURL), {
				responseType: 'stream',
				decompress: false,
			});
		} catch (error: any) {
			logger.warn(`Couldn't fetch file from URL "${importURL}"${error.message ? `: ${error.message}` : ''}`);
			logger.trace(error);

			throw new ServiceUnavailableError({
				service: 'external-file',
				reason: `Couldn't fetch file from URL "${importURL}"`,
			});
		}

		let filename: string;
		let mimeType: string;

		try {
			const parsedURL = url.parse(fileResponse.request.res.responseUrl);
			filename = decodeURI(path.basename(parsedURL.pathname as string));

			mimeType = fileResponse.headers['content-type']?.split(';')[0]?.trim() || 'application/octet-stream';

			// Check against global MIME type allow list from env
			if (isMimeTypeAllowed(mimeType, env['FILES_MIME_TYPE_ALLOW_LIST'] as string | string[]) === false) {
				throw new InvalidPayloadError({
					reason: `File content type "${mimeType}" is not allowed for upload by your global file type restrictions`,
				});
			}

			const { filterMimeType } = options;

			// Check against interface-level MIME type restrictions if provided
			if (filterMimeType && filterMimeType.length > 0 && isMimeTypeAllowed(mimeType, filterMimeType) === false) {
				throw new InvalidPayloadError({
					reason: `File content type "${mimeType}" is not allowed for upload by this field's file type restrictions`,
				});
			}
		} catch (error) {
			// Nothing reads the response body once the import is rejected, so it would hold its connection open
			fileResponse.data.destroy();

			throw error;
		}

		const payload = {
			filename_download: filename,
			type: mimeType,
			title: formatTitle(filename),
			...(body || {}),
		};

		return await this.uploadOne(decompressResponse(fileResponse.data, fileResponse.headers), payload, payload.id);
	}

	/**
	 * Create a file
	 */
	override async createOne(data: Partial<File>, opts: MutationOptions = {}): Promise<PrimaryKey> {
		if (!data.type) {
			throw new InvalidPayloadError({ reason: `"type" is required` });
		}

		if (data.filename_disk) {
			data.filename_disk = sanitizeFilepath(data.filename_disk);

			try {
				assertValidStoragePath(data.filename_disk, data.storage);
				await assertUniqueFilename(this.knex, data.filename_disk);
			} catch (err: any) {
				// Defer the error to be thrown until after permission checks
				opts.preMutationError = err;
			}
		}

		const key = await super.createOne(data, opts);
		return key;
	}

	/**
	 * Update many files
	 */
	override async updateMany(
		keys: PrimaryKey[],
		data: Partial<File>,
		opts: MutationOptions = {},
	): Promise<PrimaryKey[]> {
		if (keys.length === 1 && data.filename_disk) {
			data.filename_disk = sanitizeFilepath(data.filename_disk);

			try {
				assertValidStoragePath(data.filename_disk, data.storage);
				await assertUniqueFilename(this.knex, data.filename_disk, keys[0]);
			} catch (err: any) {
				// Defer the error to be thrown until after permission checks
				opts.preMutationError = err;
			}

			// Fetch existing records to have data prior to change, dont require read permissions.
			const sudoFilesItemsService = new FilesService({
				knex: this.knex,
				schema: this.schema,
			});

			const updatedFiles: Map<PrimaryKey, File> = new Map();

			const changedFiles = await sudoFilesItemsService.readMany(keys, {
				fields: ['id', 'storage', 'filename_disk'],
			});

			for (const file of changedFiles) {
				updatedFiles.set(file.id, file);
			}

			for (const key of keys) {
				const file = updatedFiles.get(key);

				// The physical object may be shared with other records when earlier
				// uploads were deduplicated. A shared object is copied instead of moved
				// and its generated assets are left in place for the other records.
				// Determined up front: querying the pool from inside the transaction
				// below would deadlock on SQLite.
				let fileIsShared = false;

				if (file?.filename_disk && sanitizeFilepath(file.filename_disk) !== data.filename_disk) {
					fileIsShared = await this.isFileShared(file['storage'], sanitizeFilepath(file.filename_disk), key);
				}

				// Transaction per file to ensure we only rollback changes related to that file on error
				await transaction(this.knex, async (trx) => {
					const filesItemService = new ItemsService(this.collection, {
						knex: trx,
						schema: this.schema,
						accountability: this.accountability,
					});

					await filesItemService.updateMany([key], data, opts);

					// if filename is present and was updated rename files it was changed
					if (data.filename_disk) {
						const storage = await getStorage();

						if (!file || !file.filename_disk) return;

						// For backwards compatibility it must be resolved first to ensure consistent path
						const existingFilePath = sanitizeFilepath(file.filename_disk);

						if (existingFilePath === data.filename_disk) return;

						const disk = storage.location(file['storage']);

						const { name: filePrefix, dir: fileDir } = path.parse(existingFilePath);
						const updatedFilePath = sanitizeFilepath(data.filename_disk);

						let remoteFileExists: boolean;

						try {
							remoteFileExists = await disk.exists(data.filename_disk);
						} catch (error) {
							// A failed lookup is not the same answer as a missing file, and both branches below act on it
							throw new ServiceUnavailableError(
								{ service: 'files', reason: `Couldn't reach the storage location` },
								{ cause: error },
							);
						}

						const filePrefixPath = fileDir ? normalizePath(path.join(fileDir, filePrefix)) : filePrefix;

						for await (const filePath of disk.list(filePrefixPath)) {
							/**
							 * If the remote file exists, repoint the primary asset to it (i.e. db update only).
							 * If the remote file does not exist, move the primary asset to location.
							 *
							 * NOTE
							 * - On repoint the original asset will be deleted if `FILES_DELETE_ORIGINAL_ON_MOVE` is true.
							 * - Any associated generated assets are deleted.
							 */
							if (filePath === existingFilePath) {
								if (!remoteFileExists) {
									if (fileIsShared) {
										await disk.copy(filePath, updatedFilePath);
									} else {
										await disk.move(filePath, updatedFilePath);
									}

									continue;
								} else if (toBoolean(env['FILES_DELETE_ORIGINAL_ON_MOVE']) === false) {
									continue;
								}
							}

							// generated assets of a shared object stay in place for the other records
							if (fileIsShared) continue;

							// always delete generated assets
							await disk.delete(filePath);
						}
					}
				});
			}

			return keys;
		}

		if (keys.length > 1 && data.filename_disk) {
			// Defer the error to be thrown until after permission checks
			opts.preMutationError = new InvalidPayloadError({
				reason: '"filename_disk" cannot be modified in bulk operations',
			});
		}

		await super.updateMany(keys, data, opts);

		return keys;
	}

	/**
	 * Delete multiple files
	 */
	override async deleteMany(keys: PrimaryKey[]): Promise<PrimaryKey[]> {
		const sudoFilesItemsService = new FilesService({
			knex: this.knex,
			schema: this.schema,
		});

		const files = await sudoFilesItemsService.readMany(keys, { fields: ['id', 'storage', 'filename_disk'], limit: -1 });

		await super.deleteMany(keys);

		for (const file of files) {
			// Physical objects may be shared between records when uploads were deduplicated;
			// they're only removed once no remaining record references them
			await this.deleteFileIfUnreferenced(file['storage'], file['filename_disk']);
		}

		return keys;
	}

	override async readByQuery(query: Query, opts?: QueryOptions | undefined) {
		const filteredQuery = cloneDeep(query);

		if (RESUMABLE_UPLOADS.ENABLED === true) {
			const filterPartialUploads = { tus_id: { _null: true } };

			if (!filteredQuery.filter) {
				filteredQuery.filter = filterPartialUploads;
			} else if ('_and' in filteredQuery.filter && Array.isArray(filteredQuery.filter['_and'])) {
				filteredQuery.filter['_and'].push(filterPartialUploads);
			} else {
				filteredQuery.filter = {
					_and: [filteredQuery.filter, filterPartialUploads],
				};
			}
		}

		return super.readByQuery(filteredQuery, opts);
	}
}

function decompressResponse(stream: Readable, headers: AxiosResponse['headers']) {
	const contentEncoding = (headers['content-encoding'] || '').toLowerCase();

	if (!['gzip', 'deflate', 'br'].includes(contentEncoding)) {
		return stream;
	}

	let isEmpty = true;

	const checker = new TransformStream({
		transform(data, _encoding, callback) {
			if (isEmpty === false) {
				callback(null, data);
				return;
			}

			isEmpty = false;

			handleContentEncoding(data);

			callback(null, data);
		},

		flush(callback) {
			callback();
		},
	});

	const finalStream = new PassThroughStream({
		autoDestroy: false,
		destroy(error, callback) {
			stream.destroy();

			callback(error);
		},
	});

	stream.pipe(checker);

	return finalStream;

	function handleContentEncoding(data: any) {
		let decompressStream;

		if (contentEncoding === 'br') {
			decompressStream = zlib.createBrotliDecompress();
		} else if (contentEncoding === 'deflate' && isDeflateAlgorithm(data)) {
			decompressStream = zlib.createInflateRaw();
		} else {
			decompressStream = zlib.createUnzip();
		}

		decompressStream.once('error', (error) => {
			if (isEmpty && !stream.readable) {
				finalStream.end();
				return;
			}

			finalStream.destroy(error);
		});

		checker.pipe(decompressStream).pipe(finalStream);
	}

	function isDeflateAlgorithm(data: any) {
		const DEFLATE_ALGORITHM_HEADER = 0x08;

		return data.length > 0 && (data[0] & DEFLATE_ALGORITHM_HEADER) === 0;
	}
}
