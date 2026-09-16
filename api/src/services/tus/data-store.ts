import { extname, parse } from 'node:path';
import stream from 'node:stream';
import { useEnv } from '@directus/env';
import { UnsupportedMediaTypeError } from '@directus/errors';
import formatTitle from '@directus/format-title';
import type { TusDriver } from '@directus/storage';
import type { Accountability, ChunkedUploadContext, File, SchemaOverview } from '@directus/types';
import { DataStore, ERRORS, Upload } from '@tus/utils';
import { omit } from 'lodash-es';
import { extension } from 'mime-types';
import getDatabase from '../../database/index.js';
import { useLogger } from '../../logger/index.js';
import { assertUniqueFilename } from '../files/lib/assert-unique-filename.js';
import { assertValidStoragePath } from '../files/lib/assert-valid-storage-path.js';
import {
	countFileReferences,
	findDedupeCandidate,
	getAvailableFilenameDisk,
	getDedupeAlgorithm,
	hashStoredFile,
	isDedupeEnabled,
} from '../files/lib/dedupe.js';
import { isMimeTypeAllowed } from '../files/lib/is-mime-type-allowed.js';
import { sanitizeFilepath } from '../files/lib/sanitize-filepath.js';
import { ItemsService } from '../items.js';

export type TusDataStoreConfig = {
	constants: {
		ENABLED: boolean;
		CHUNK_SIZE: number | null;
		EXPIRATION_TIME: number;
		SCHEDULE: string;
	};
	/** Storage location name **/
	location: string;
	driver: TusDriver;

	schema: SchemaOverview;
	accountability: Accountability | undefined;
};

export class TusDataStore extends DataStore {
	protected chunkSize: number | undefined;
	protected expirationTime: number;
	protected location: string;
	protected storageDriver: TusDriver;
	protected schema: SchemaOverview;
	protected accountability: Accountability | undefined;

	constructor(config: TusDataStoreConfig) {
		super();

		if (config.constants.CHUNK_SIZE !== null) this.chunkSize = config.constants.CHUNK_SIZE;
		this.expirationTime = config.constants.EXPIRATION_TIME;
		this.location = config.location;
		this.storageDriver = config.driver;
		this.extensions = this.storageDriver.tusExtensions;
		this.schema = config.schema;
		this.accountability = config.accountability;
	}

	public override async create(upload: Upload): Promise<Upload> {
		const logger = useLogger();
		const knex = getDatabase();

		const filesItemsService = new ItemsService<File>('directus_files', {
			accountability: this.accountability,
			schema: this.schema,
			knex,
		});

		upload.creation_date = new Date().toISOString();

		if (!upload.size || !upload.metadata || !upload.metadata['filename_download']) {
			throw ERRORS.INVALID_METADATA;
		}

		if (!upload.metadata['type']) {
			upload.metadata['type'] = 'application/octet-stream';
		}

		const mimeType = upload.metadata['type'];
		const env = useEnv();

		if (isMimeTypeAllowed(mimeType, env['FILES_MIME_TYPE_ALLOW_LIST'] as string | string[]) === false) {
			throw new UnsupportedMediaTypeError({ mediaType: mimeType, where: 'tus upload' });
		}

		if (!upload.metadata['title']) {
			upload.metadata['title'] = formatTitle(upload.metadata['filename_download']);
		}

		let existingFile: Record<string, unknown> | undefined;

		// If the payload contains a primary key, we'll check if the file already exists for replacement
		if (upload.metadata['id']) {
			existingFile = await knex.select('tus_id').from('directus_files').andWhere({ id: upload.metadata['id'] }).first();

			if (existingFile && existingFile['tus_id'] !== null) {
				throw ERRORS.INVALID_METADATA;
			}
		}

		const fileData: Partial<File> = {
			...omit(upload.metadata, ['id']),
			tus_id: upload.id,
			tus_data: upload,
			filesize: upload.size,
			storage: this.location,
		};

		if (fileData.filename_disk) {
			fileData.filename_disk = sanitizeFilepath(fileData.filename_disk);
			assertValidStoragePath(fileData.filename_disk, this.location);
			await assertUniqueFilename(knex, fileData.filename_disk, upload.metadata['id']);
		}

		// If no folder is specified, we'll use the default folder from the settings if it exists
		if ('folder' in fileData === false) {
			const settings = await knex.select('storage_default_folder').from('directus_settings').first();

			if (settings?.storage_default_folder) {
				fileData.folder = settings.storage_default_folder;
			}
		}

		// Generate a placeholder record for the upload (to be upgrade/deleted on complete depending on new/replacement)
		const primaryKey = await filesItemsService.createOne(fileData, { emitEvents: false });

		// Point metadata.id at the placeholder record unless this is a valid replacement
		if (!existingFile) {
			upload.metadata['id'] = primaryKey as string;
		}

		const fileExtension =
			extname(upload.metadata['filename_download']) ||
			(upload.metadata['type'] && '.' + extension(upload.metadata['type'])) ||
			'';

		// The filename_disk is the FINAL filename on disk
		fileData.filename_disk ||= primaryKey + (fileExtension || '');

		try {
			// Write the file to a temp location first to avoid possibly overwriting an existing file if something goes wrong
			upload = (await this.storageDriver.createChunkedUpload(fileData.filename_disk, upload)) as Upload;

			fileData.tus_data = upload;

			await filesItemsService.updateOne(primaryKey!, fileData, { emitEvents: false });

			return upload;
		} catch (err) {
			logger.warn(`Couldn't create chunked upload for ${fileData.filename_disk}`);
			logger.warn(err);

			// Remove the temporary created file
			await filesItemsService.deleteOne(primaryKey!, { emitEvents: false });

			throw ERRORS.UNKNOWN_ERROR;
		}
	}

	public override async write(readable: stream.Readable, tus_id: string, offset: number): Promise<number> {
		const logger = useLogger();
		const fileData = await this.getFileById(tus_id);
		const filePath = fileData.filename_disk!;

		const sudoFilesItemsService = new ItemsService<File>('directus_files', {
			schema: this.schema,
		});

		try {
			const newOffset = await this.storageDriver.writeChunk(
				filePath,
				readable,
				offset,
				fileData.tus_data as ChunkedUploadContext,
			);

			await sudoFilesItemsService.updateOne(fileData.id!, {
				tus_data: {
					...fileData.tus_data,
					offset: newOffset,
				},
			});

			if (Number(fileData.filesize) === newOffset) {
				try {
					await this.storageDriver.finishChunkedUpload(filePath, fileData.tus_data as ChunkedUploadContext);
				} catch (err) {
					await this.remove(fileData.tus_id!);
					throw err;
				}

				const targetId = fileData.tus_data?.['metadata']?.['id'] as string | undefined;
				const isReplacement = targetId && targetId !== fileData.id;

				// If the file is a replacement, delete the old files, and upgrade the temp file. DB record will be cleanup on in onUploadFinish handler
				if (isReplacement) {
					const replaceData = await sudoFilesItemsService.readOne(targetId, { fields: ['filename_disk'] });

					const dedupeOutcome = await this.dedupeCompletedUpload({
						filePath,
						filesize: newOffset,
						targetId,
						placeholderId: fileData.id!,
						currentFilenameDisk: replaceData.filename_disk,
					});

					if (dedupeOutcome.handled === false) {
						// delete the previously saved file and thumbnails to ensure they're generated fresh
						for await (const partPath of this.storageDriver.list(targetId)) {
							await this.storageDriver.delete(partPath);
						}

						// Upgrade the temp file to the final filename
						await this.storageDriver.move(filePath, replaceData.filename_disk);
					}
				} else {
					await this.dedupeCompletedUpload({
						filePath,
						filesize: newOffset,
						targetId: fileData.id!,
						placeholderId: fileData.id!,
						currentFilenameDisk: filePath,
					});
				}
			}

			return newOffset;
		} catch (err: any) {
			logger.error(err, 'Error writing chunk for upload "%s" at offset %d', tus_id, offset);

			if ('status_code' in err && err.status_code === 500) {
				throw err;
			}

			throw ERRORS.FILE_WRITE_ERROR;
		}
	}

	override async remove(tus_id: string): Promise<void> {
		const sudoFilesItemsService = new ItemsService<File>('directus_files', {
			schema: this.schema,
		});

		const fileData = await this.getFileById(tus_id);
		await this.storageDriver.deleteChunkedUpload(fileData.filename_disk!, fileData.tus_data as ChunkedUploadContext);
		await sudoFilesItemsService.deleteOne(fileData.id!);
	}

	/**
	 * Deduplicate a completed chunked upload.
	 *
	 * Chunked uploads never pass through the API as a single stream, so the checksum is
	 * calculated by streaming the assembled file back from storage. When an identical
	 * object already exists in the same storage location, the assembled copy is discarded
	 * and the file record is pointed at the shared object instead.
	 *
	 * Returns `handled: true` when the upload was fully placed (the caller must not move
	 * or delete anything else) and `handled: false` when the caller should fall back to
	 * the default placement logic.
	 */
	private async dedupeCompletedUpload(options: {
		filePath: string;
		filesize: number;
		targetId: string;
		placeholderId: string;
		currentFilenameDisk: string;
	}): Promise<{ handled: boolean }> {
		const logger = useLogger();
		const knex = getDatabase();

		const sudoFilesItemsService = new ItemsService<File>('directus_files', {
			schema: this.schema,
		});

		const isReplacement = options.targetId !== options.placeholderId;

		// A previously deduplicated (shared) object must never be overwritten or deleted
		// by a replacement. This is checked up front so that every fallback below —
		// including a failed dedupe attempt — still respects it. If the check itself
		// fails, the upload fails safe instead of risking the shared object.
		const oldFileShared = isReplacement
			? await this.isPhysicalFileShared(options.currentFilenameDisk, options.targetId)
			: false;

		// Store the assembled file under a fresh name, leaving the shared object untouched
		const moveToFreshFilename = async (checksum?: string): Promise<void> => {
			const filenameDisk = await getAvailableFilenameDisk(knex, {
				base: options.targetId,
				extension: extname(options.filePath),
				excludeIds: [options.targetId, options.placeholderId],
			});

			await sudoFilesItemsService.updateOne(
				options.targetId,
				{ filename_disk: filenameDisk, ...(checksum ? { checksum } : {}) },
				{ emitEvents: false },
			);

			await this.storageDriver.move(options.filePath, filenameDisk);
		};

		if (isDedupeEnabled() === false) {
			if (isReplacement === false) return { handled: false };

			// The content was replaced without a checksum being calculated, so any
			// checksum the record carried before is now stale and must be cleared
			await sudoFilesItemsService.updateOne(options.targetId, { checksum: null }, { emitEvents: false });

			if (oldFileShared === false) return { handled: false };

			await moveToFreshFilename();
			return { handled: true };
		}

		try {
			const algorithm = getDedupeAlgorithm();
			const checksum = await hashStoredFile(this.storageDriver, options.filePath, algorithm);

			// Matching on checksum and filesize within the same storage location guards
			// against digest collisions before a physical object is reused
			const candidate = await findDedupeCandidate(knex, {
				storage: this.location,
				checksum,
				filesize: options.filesize,
				excludeIds: [options.targetId, options.placeholderId],
			});

			// The candidate's object has to still exist in storage; a stale database row is not a valid reuse target
			if (candidate && (await this.storageDriver.exists(candidate.filename_disk))) {
				// Discard the assembled copy and point the record at the shared object
				await this.storageDriver.delete(options.filePath);

				await sudoFilesItemsService.updateOne(
					options.targetId,
					{ filename_disk: candidate.filename_disk, checksum },
					{ emitEvents: false },
				);

				if (isReplacement && options.currentFilenameDisk !== candidate.filename_disk) {
					await this.deletePhysicalFileIfUnreferenced(options.currentFilenameDisk);
				}

				return { handled: true };
			}

			// No reusable object: keep the assembled file and record its checksum
			if (isReplacement) {
				if (oldFileShared) {
					await moveToFreshFilename(checksum);
					return { handled: true };
				}

				await sudoFilesItemsService.updateOne(options.targetId, { checksum }, { emitEvents: false });

				// Let the caller place the assembled file at the target's existing filename
				return { handled: false };
			}

			// New uploads are already assembled at their final path; only the checksum is missing
			await sudoFilesItemsService.updateOne(options.targetId, { checksum }, { emitEvents: false });

			return { handled: true };
		} catch (err) {
			// Deduplication must never break an upload; fall back to the default placement,
			// but never to one that would destroy a shared object
			logger.warn(`Couldn't deduplicate the chunked upload, storing it as a new file`);
			logger.warn(err);

			if (isReplacement) {
				// The content changed without a checksum being calculated, so any checksum
				// the record carried before is now stale and must be cleared
				await sudoFilesItemsService.updateOne(options.targetId, { checksum: null }, { emitEvents: false });

				if (oldFileShared) {
					await moveToFreshFilename();
					return { handled: true };
				}
			}

			return { handled: false };
		}
	}

	/**
	 * Whether a physical object is referenced by any file record other than the given one
	 */
	private async isPhysicalFileShared(filenameDisk: string, excludeId: string): Promise<boolean> {
		const knex = getDatabase();

		const references = await countFileReferences(knex, {
			storage: this.location,
			filename_disk: filenameDisk,
			excludeIds: [excludeId],
		});

		return references > 0;
	}

	/**
	 * Delete a physical object and its generated assets from storage, but only when no
	 * file record references it anymore. Shared objects are left untouched.
	 */
	private async deletePhysicalFileIfUnreferenced(filenameDisk: string): Promise<void> {
		const knex = getDatabase();

		const references = await countFileReferences(knex, {
			storage: this.location,
			filename_disk: filenameDisk,
		});

		if (references > 0) return;

		const filePrefix = parse(filenameDisk).name;

		for await (const filepath of this.storageDriver.list(filePrefix)) {
			await this.storageDriver.delete(filepath);
		}
	}

	override async deleteExpired(): Promise<number> {
		const sudoFilesItemsService = new ItemsService<File>('directus_files', {
			schema: this.schema,
		});

		const now = new Date();
		const toDelete: Promise<void>[] = [];

		const uploadFiles = await sudoFilesItemsService.readByQuery({
			fields: ['modified_on', 'tus_id', 'tus_data'],
			filter: { tus_id: { _nnull: true } },
		});

		if (!uploadFiles) return 0;

		for (const fileData of uploadFiles) {
			if (
				fileData &&
				fileData.tus_data &&
				this.getExpiration() > 0 &&
				fileData.tus_data['size'] !== fileData.tus_data['offset'] &&
				fileData.modified_on
			) {
				const modified = new Date(fileData.modified_on);
				const expires = new Date(modified.getTime() + this.getExpiration());

				if (now > expires) {
					toDelete.push(this.remove(fileData.tus_id!));
				}
			}
		}

		await Promise.allSettled(toDelete);
		return toDelete.length;
	}

	override getExpiration(): number {
		return this.expirationTime;
	}

	override async getUpload(id: string): Promise<Upload> {
		const fileData = await this.getFileById(id);

		return new Upload(fileData.tus_data as any);
	}

	protected async getFileById(tus_id: string) {
		const sudoFilesItemsService = new ItemsService<File>('directus_files', {
			schema: this.schema,
		});

		const results = await sudoFilesItemsService.readByQuery({
			filter: {
				tus_id: { _eq: tus_id },
				storage: { _eq: this.location },
				...(this.accountability?.user ? { uploaded_by: { _eq: this.accountability.user } } : {}),
			},
		});

		if (!results || !results[0]) {
			throw ERRORS.FILE_NOT_FOUND;
		}

		return results[0] as File;
	}
}
