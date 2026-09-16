import type { OfflineQueueStorage, QueuedRequestSnapshot } from './types.js';

/**
 * Default queue storage: keeps snapshots in memory for the lifetime of the
 * client. Snapshots are structurally cloned so callers cannot mutate stored
 * requests and non-serializable payloads (e.g. FormData) fail early.
 */
export const memoryQueueStorage = (): OfflineQueueStorage => {
	let entries: QueuedRequestSnapshot[] = [];

	return {
		async get() {
			return entries.map(cloneSnapshot);
		},
		async set(next) {
			entries = next.map(cloneSnapshot);
		},
	};
};

/**
 * Queue storage backed by a Web Storage implementation (localStorage/sessionStorage).
 * Each write fully replaces the stored list.
 */
export const webStorageQueueAdapter = (
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
	key = 'directus-offline-queue',
): OfflineQueueStorage => {
	return {
		async get() {
			const raw = storage.getItem(key);
			if (!raw) return [];

			try {
				const parsed = JSON.parse(raw) as QueuedRequestSnapshot[];
				return Array.isArray(parsed) ? parsed : [];
			} catch {
				return [];
			}
		},
		async set(entries) {
			if (entries.length === 0) {
				storage.removeItem(key);
			} else {
				storage.setItem(key, JSON.stringify(entries));
			}
		},
	};
};

const cloneSnapshot = (snapshot: QueuedRequestSnapshot): QueuedRequestSnapshot =>
	JSON.parse(JSON.stringify(snapshot)) as QueuedRequestSnapshot;
