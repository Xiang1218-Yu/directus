import getDatabase from '../../../database/index.js';
import { useLogger } from '../../../logger/index.js';
import { getDedupeAlgorithm, hashStoredFile } from '../../../services/files/lib/dedupe.js';
import { getStorage } from '../../../storage/index.js';

const BATCH_SIZE = 100;

/**
 * Backfill checksums for files that were uploaded before deduplication was enabled
 * (or while it was disabled). Files without a checksum are never considered as dedupe
 * candidates, so running this allows existing content to participate in deduplication.
 */
export default async function filesChecksumsBackfill(): Promise<void> {
	const database = getDatabase();
	const logger = useLogger();

	const algorithm = getDedupeAlgorithm();

	logger.info(`Calculating missing file checksums (algorithm: ${algorithm})...`);

	try {
		const storage = await getStorage();

		let updated = 0;
		let failed = 0;
		const failedIds: string[] = [];

		for (;;) {
			const query = database
				.select('id', 'storage', 'filename_disk')
				.from('directus_files')
				.whereNull('checksum')
				.whereNull('tus_id')
				.orderBy('id', 'asc')
				.limit(BATCH_SIZE);

			// Files that failed in a previous batch would otherwise be selected again
			if (failedIds.length > 0) {
				query.whereNotIn('id', failedIds);
			}

			const files = await query;

			if (files.length === 0) break;

			for (const file of files) {
				try {
					const disk = storage.location(file.storage);
					const checksum = await hashStoredFile(disk, file.filename_disk, algorithm);

					await database('directus_files').update({ checksum }).where({ id: file.id });

					updated++;
				} catch (err: any) {
					failed++;
					failedIds.push(file.id);

					logger.warn(`Couldn't calculate checksum for file ${file.id} (${file.filename_disk}): ${err.message}`);
				}
			}

			logger.info(`Processed ${updated + failed} files (${updated} updated, ${failed} failed)...`);
		}

		logger.info(`Done. Backfilled checksums for ${updated} file(s), ${failed} failure(s).`);

		await database.destroy();
		process.exit(failed > 0 ? 1 : 0);
	} catch (err: any) {
		logger.error(err);
		await database.destroy();
		process.exit(1);
	}
}
