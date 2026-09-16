import type { HttpMethod, RequestOptions } from '../types/request.js';
import {
	classifyError,
	QueueCancellationError,
	QueueDependencyError,
	QueueRejectedError,
	QueueRetryExhaustedError,
} from './errors.js';
import { browserNetworkMonitor, staticNetworkMonitor } from './network.js';
import { memoryQueueStorage } from './storage.js';
import type {
	EnqueueOptions,
	NetworkMonitor,
	OfflineQueue,
	OfflineQueueOptions,
	OfflineQueueStorage,
	QueueEntry,
	QueuedRequest,
	QueuedRequestSnapshot,
} from './types.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30_000;

/** Methods that only read data. Always safe to queue/replay. */
const SAFE_METHODS = new Set<HttpMethod>(['GET', 'SEARCH']);
/** Methods that are idempotent per the HTTP specification, safe to replay unkeyed. */
const IDEMPOTENT_METHODS = new Set<HttpMethod>(['PUT', 'DELETE']);

let idCounter = 0;

const generateId = (): string => {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	return `id-${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

const defaultRetryDelay = (attempt: number): number => {
	const exponential = Math.min(DEFAULT_BASE_DELAY * 2 ** (attempt - 1), DEFAULT_MAX_DELAY);
	// full jitter to avoid thundering herd replays
	return Math.round(Math.random() * exponential);
};

const defaultNetworkMonitor = (): NetworkMonitor => {
	if (typeof globalThis.navigator !== 'undefined' && 'onLine' in globalThis.navigator) {
		return browserNetworkMonitor();
	}

	return staticNetworkMonitor(true);
};

export interface InternalOfflineQueueOptions extends OfflineQueueOptions {
	/**
	 * Accept `FormData` bodies (file uploads) for queuing. Off by default:
	 * bodies cannot be persisted and replaying a multipart upload may
	 * duplicate files.
	 */
	allowFileUploads?: boolean;
	/**
	 * Accept POST/PATCH requests without an idempotency key. Off by default:
	 * replaying an unkeyed non-idempotent request may duplicate the mutation.
	 */
	allowNonIdempotent?: boolean;
}

/** Queue with the exposed promise that resolves once persisted entries are restored. */
export interface InitializedOfflineQueue extends OfflineQueue {
	/** Resolves once restart recovery finished and network listeners are attached. */
	readonly restored: Promise<void>;
}

/**
 * Creates an offline request queue synchronously. Restart recovery from the
 * storage adapter runs in the background; `flush` waits for it. The queue is
 * transport agnostic: an executor function performs the actual request, which
 * keeps the core replay/deduplication/retry logic usable without a Directus
 * client (and fully testable). The `offline()` composable wires the executor
 * to the REST request pipeline.
 */
export const createOfflineQueueCore = (options: InternalOfflineQueueOptions = {}): InitializedOfflineQueue => {
	const storage: OfflineQueueStorage = options.storage ?? memoryQueueStorage();
	const networkMonitor: NetworkMonitor = options.networkMonitor ?? defaultNetworkMonitor();
	const maxRetriesDefault = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const retryDelay: (attempt: number) => number = options.retryDelay ?? defaultRetryDelay;
	const flushOnReconnect = options.flushOnReconnect ?? true;

	const entries = new Map<string, QueueEntry>();
	let flushInProgress: Promise<void> | null = null;
	/** A flush was requested while another cycle was active; run another pass afterwards. */
	let flushRerequested = false;
	let paused = false;
	let destroyed = false;
	let refreshInProgress: Promise<void> | null = null;
	/** Whether a token refresh already happened for the current flush cycle. */
	let cycleRefreshed = false;
	let writeChain: Promise<unknown> = Promise.resolve();
	let releaseWrites!: () => void;
	const retryTimers = new Set<ReturnType<typeof setTimeout>>();
	let unsubscribeNetwork: (() => void) | null = null;
	let resolveRestored!: () => void;
	const restored = new Promise<void>((resolve) => {
		resolveRestored = resolve;
	});

	/**
	 * Writes are gated until recovery is finished, so an enqueue happening
	 * before the storage adapter was read cannot clobber persisted entries.
	 */
	writeChain = new Promise<void>((resolve) => {
		releaseWrites = resolve;
	});

	// ---------------------------------------------------------------------
	// entry helpers
	// ---------------------------------------------------------------------

	const createEntry = (snapshot: QueuedRequestSnapshot): QueueEntry => ({
		snapshot,
		status: 'queued',
		waiters: [],
		abortController: null,
	});

	const findByIdOrKey = (idOrKey: string): QueueEntry | undefined =>
		entries.get(idOrKey) ??
		[...entries.values()].find((entry) => entry.snapshot.idempotencyKey === idOrKey);

	/** Persist all non-terminal entries; terminal/in-flight entries are stored as queued. */
	const persist = () => {
		const snapshots = [...entries.values()]
			.filter((entry) => entry.status === 'queued' || entry.status === 'flushing')
			.map((entry) => entry.snapshot);

		writeChain = writeChain
			.then(() => storage.set(snapshots))
			.catch((error) => options.hooks?.onError?.(undefined as unknown as QueueEntry, error));

		return writeChain;
	};

	const settleSuccess = (entry: QueueEntry, result: unknown) => {
		entry.status = 'succeeded';
		entry.settledResult = result;
		entry.abortController = null;
		options.hooks?.onSuccess?.(entry, result);

		for (const waiter of entry.waiters) waiter.resolve(result);
		entry.waiters = [];
	};

	/**
	 * Fail an entry and cascade the failure to every queued entry that
	 * (transitively) depends on it, so dependents never replay after a
	 * prerequisite failed.
	 */
	const settleFailure = (entry: QueueEntry, error: unknown) => {
		entry.status = 'failed';
		entry.settledError = error;
		entry.abortController = null;
		options.hooks?.onError?.(entry, error);

		for (const waiter of entry.waiters) waiter.reject(error);
		entry.waiters = [];

		const cascade = (failed: QueueEntry) => {
			for (const candidate of entries.values()) {
				if (candidate.status !== 'queued') continue;
				if (!candidate.snapshot.dependsOn.includes(failed.snapshot.id)) continue;

				const dependencyError = new QueueDependencyError(candidate.snapshot.id, failed.snapshot.id);
				candidate.settledError = dependencyError;
				candidate.status = 'failed';
				options.hooks?.onError?.(candidate, dependencyError);

				for (const waiter of candidate.waiters) waiter.reject(dependencyError);
				candidate.waiters = [];

				cascade(candidate);
			}
		};

		cascade(entry);
	};

	/** Remove terminal entries. Called once a flush cycle settles. */
	const pruneTerminal = () => {
		for (const [id, entry] of entries) {
			if ((entry.status === 'succeeded' || entry.status === 'failed') && entry.waiters.length === 0) {
				entries.delete(id);
			}
		}
	};

	// ---------------------------------------------------------------------
	// cancellation
	// ---------------------------------------------------------------------

	const pendingCancellations = new Map<string, QueueCancellationError>();

	const cancelEntry = (entry: QueueEntry, reason?: string): boolean => {
		if (entry.status === 'succeeded' || entry.status === 'failed') return false;

		const error = new QueueCancellationError(entry.snapshot.id, reason);

		if (entry.status === 'flushing') {
			// abort the in-flight fetch; the processing loop turns this into
			// the queue cancellation error
			pendingCancellations.set(entry.snapshot.id, error);
			entry.abortController?.abort(reason ?? 'cancelled');
			return true;
		}

		settleFailure(entry, error);
		pruneTerminal();
		persist();
		options.hooks?.onCancel?.(entry);
		return true;
	};

	// ---------------------------------------------------------------------
	// replay
	// ---------------------------------------------------------------------

	const waitForRetry = (delay: number, signal: AbortSignal): Promise<void> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				retryTimers.delete(timer);
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, delay);

			const onAbort = () => {
				clearTimeout(timer);
				retryTimers.delete(timer);
				reject(new QueueCancellationError('aborted'));
			};

			retryTimers.add(timer);
			if (signal.aborted) onAbort();
			else signal.addEventListener('abort', onAbort, { once: true });
		});

	const processEntry = async (entry: QueueEntry): Promise<void> => {
		if (entry.status !== 'queued') return;

		entry.status = 'flushing';
		let refreshed = false;

		// attempts counts failures. The first try is not a retry, so the
		// request is sent up to maxRetries + 1 times.
		while (true) {
			if (destroyed) {
				settleFailure(entry, new QueueCancellationError(entry.snapshot.id, 'Queue destroyed'));
				return;
			}

			entry.abortController = new AbortController();

			const queuedCancellation = pendingCancellations.get(entry.snapshot.id);
			if (queuedCancellation) {
				pendingCancellations.delete(entry.snapshot.id);
				settleFailure(entry, queuedCancellation);
				return;
			}

			options.hooks?.onReplay?.(entry, entry.snapshot.attempts + 1);

			try {
				const result = await options.executor?.(entry, entry.abortController.signal);

				pendingCancellations.delete(entry.snapshot.id);
				settleSuccess(entry, result);
				return;
			} catch (error) {
				const forcedCancellation = pendingCancellations.get(entry.snapshot.id);
				if (forcedCancellation) {
					pendingCancellations.delete(entry.snapshot.id);
					settleFailure(entry, forcedCancellation);
					options.hooks?.onCancel?.(entry);
					return;
				}

				const kind = classifyError(error);

				if (kind === 'cancelled') {
					settleFailure(entry, new QueueCancellationError(entry.snapshot.id));
					return;
				}

				if (kind === 'auth') {
					// expired credentials: single-flight a token refresh (all
					// concurrent 401s share it), then replay exactly once.
					if (!refreshed && options.onAuthRefresh) {
						refreshed = true;

						try {
							if (cycleRefreshed && !refreshInProgress) {
								// another entry already refreshed the token in
								// this flush cycle; retry once without another
								// refresh
								continue;
							}

							if (!refreshInProgress) {
								refreshInProgress = Promise.resolve(options.onAuthRefresh(error)).finally(() => {
									refreshInProgress = null;
								});
							}

							await refreshInProgress;
							cycleRefreshed = true;
							continue;
						} catch {
							// refresh failed: settle with the original auth
							// error so the existing SDK error type is preserved
							settleFailure(entry, error);
							return;
						}
					}

					settleFailure(entry, error);
					return;
				}

				if (kind === 'validation') {
					// retrying cannot fix a malformed request
					settleFailure(entry, error);
					return;
				}

				// network error or 5xx: consume the retry budget
				entry.snapshot.attempts += 1;
				options.hooks?.onError?.(entry, error);
				persist();

				if (entry.snapshot.attempts > entry.snapshot.maxRetries) {
					settleFailure(entry, new QueueRetryExhaustedError(entry.snapshot.id, entry.snapshot.attempts, error));
					return;
				}

				try {
					await waitForRetry(retryDelay(entry.snapshot.attempts), entry.abortController.signal);
				} catch {
					const cancellation =
						pendingCancellations.get(entry.snapshot.id) ??
						new QueueCancellationError(entry.snapshot.id);
					pendingCancellations.delete(entry.snapshot.id);
					settleFailure(entry, cancellation);
					return;
				}
			}
		}
	};

	type DependencyResolution =
		| { state: 'ready' }
		| { state: 'blocked' }
		| { state: 'failed'; dependencyId: string };

	const resolveDependencies = (entry: QueueEntry): DependencyResolution => {
		for (const reference of entry.snapshot.dependsOn) {
			// references are normalized to queue ids at enqueue time; restored
			// snapshots can still contain raw idempotency keys
			const dependency = findByIdOrKey(reference);

			// A dependency that no longer exists either succeeded earlier in
			// this session (pruned) or in a previous session (not restored).
			if (!dependency || dependency.status === 'succeeded') continue;

			if (dependency.status === 'failed') {
				return { state: 'failed', dependencyId: dependency.snapshot.id };
			}

			// dependency is still queued/flushing (including a cycle)
			return { state: 'blocked' };
		}

		return { state: 'ready' };
	};

	const runCycle = async () => {
		try {
			cycleRefreshed = false;

			while (true) {
				if (!networkMonitor.isOnline()) return;

				const pending = [...entries.values()]
					.filter((entry) => entry.status === 'queued')
					.sort((a, b) => a.snapshot.createdAt - b.snapshot.createdAt);

				if (pending.length === 0) return;

				let progress = false;

				for (const entry of pending) {
					const resolution = resolveDependencies(entry);

					if (resolution.state === 'blocked') continue;

					progress = true;

					if (resolution.state === 'failed') {
						settleFailure(
							entry,
							new QueueDependencyError(entry.snapshot.id, resolution.dependencyId),
						);
						continue;
					}

					await processEntry(entry);
				}

				if (!progress) {
					// Nothing could be sent but requests remain: they form
					// a dependency cycle and can never be replayed.
					for (const entry of pending) {
						const reference = entry.snapshot.dependsOn[0] ?? entry.snapshot.id;
						settleFailure(
							entry,
							new QueueDependencyError(entry.snapshot.id, reference, 'Unresolved dependency cycle'),
						);
					}

					return;
				}
			}
		} finally {
			if (!destroyed) {
				pruneTerminal();
				await persist();
			}
		}
	};

	const startFlush = (): Promise<void> => {
		// keep draining while other callers requested a flush concurrently
		return (async () => {
			// wait for restart recovery so restored entries flush together
			await restored;

			do {
				flushRerequested = false;
				await runCycle();
			} while (flushRerequested && !destroyed);
		})();
	};

	const flush = (): Promise<void> => {
		if (destroyed) return Promise.resolve();

		// synchronous single-flight check: concurrent callers mark a
		// follow-up pass (so late enqueues are still sent) but do not block
		// on the active drain
		if (flushInProgress) {
			flushRerequested = true;
			return Promise.resolve();
		}

		const active = startFlush();
		flushInProgress = active;

		active.then(
			() => {
				if (flushInProgress === active) flushInProgress = null;
			},
			() => {
				if (flushInProgress === active) flushInProgress = null;
			},
		);

		return active;
	};

	// ---------------------------------------------------------------------
	// enqueue
	// ---------------------------------------------------------------------

	const enqueue = <T = unknown>(
		requestOptions: RequestOptions,
		enqueueOptions: EnqueueOptions = {},
	): QueuedRequest<T> => {
		if (destroyed) throw new QueueRejectedError('Cannot enqueue into a destroyed queue');

		const method: HttpMethod = requestOptions.method ?? 'GET';

		const idempotencyKey =
			enqueueOptions.idempotencyKey ??
			(SAFE_METHODS.has(method) || IDEMPOTENT_METHODS.has(method) ? generateId() : null);

		if (typeof FormData !== 'undefined' && requestOptions.body instanceof FormData && !options.allowFileUploads) {
			throw new QueueRejectedError(
				'File uploads (FormData bodies) are not queued by default. Set `allowFileUploads` to override.',
			);
		}

		if (
			!SAFE_METHODS.has(method) &&
			!IDEMPOTENT_METHODS.has(method) &&
			!idempotencyKey &&
			!options.allowNonIdempotent
		) {
			throw new QueueRejectedError(
				`${method} requests are not idempotent. Provide an idempotency key or set \`allowNonIdempotent\`.`,
			);
		}

		// collapse duplicate submissions while one with the same key is active
		if (idempotencyKey) {
			const existing = [...entries.values()].find(
				(entry) =>
					entry.snapshot.idempotencyKey === idempotencyKey &&
					(entry.status === 'queued' || entry.status === 'flushing'),
			);

			if (existing?.promise) return existing.promise as QueuedRequest<T>;
		}

		const id = generateId();

		const headers: Record<string, string> = { ...(requestOptions.headers ?? {}) };
		// never persist a bearer token; the executor attaches a fresh one on replay
		delete headers['Authorization'];
		if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

		// normalize known idempotency-key references to queue ids
		const dependsOn = (enqueueOptions.dependsOn ?? []).map(
			(reference) => findByIdOrKey(reference)?.snapshot.id ?? reference,
		);

		const snapshot: QueuedRequestSnapshot = {
			id,
			idempotencyKey,
			dependsOn,
			path: requestOptions.path,
			method,
			params: cloneParams(requestOptions.params),
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			body: typeof requestOptions.body === 'string' ? requestOptions.body : undefined,
			maxRetries: enqueueOptions.maxRetries ?? maxRetriesDefault,
			attempts: 0,
			createdAt: Date.now() * 1000 + (idCounter++ % 1000),
		};

		const entry = createEntry(snapshot);

		if (requestOptions.onRequest || requestOptions.onResponse) {
			entry.commandHooks = {
				onRequest: requestOptions.onRequest,
				onResponse: requestOptions.onResponse,
			};
		}

		let resolveWaiter!: (value: unknown) => void;
		let rejectWaiter!: (reason: unknown) => void;
		const promise = new Promise<T>((resolve, reject) => {
			resolveWaiter = resolve as (value: unknown) => void;
			rejectWaiter = reject;
		}) as QueuedRequest<T>;

		entry.waiters.push({ resolve: resolveWaiter, reject: rejectWaiter });

		Object.defineProperties(promise, {
			id: { value: id, enumerable: true },
			idempotencyKey: { value: idempotencyKey, enumerable: true },
			cancel: {
				value: (reason?: string) => cancelEntry(entry, reason),
				enumerable: true,
			},
		});

		entry.promise = promise;
		entries.set(id, entry);

		if (requestOptions.signal) {
			if (requestOptions.signal.aborted) {
				cancelEntry(entry, 'Aborted before replay');
			} else {
				requestOptions.signal.addEventListener('abort', () => cancelEntry(entry, 'Aborted'), { once: true });
			}
		}

		// persist first, then attempt immediately when online; failures fall
		// back to the queue and replay on reconnect / retry
		persist()
			.then(() => {
				if (networkMonitor.isOnline() && !destroyed) return flush();
			})
			.catch(() => {
				// settled entries reject their waiter promises; this chain only
				// guards background persistence/flush bookkeeping
			});

		return promise;
	};

	// ---------------------------------------------------------------------
	// lifecycle
	// ---------------------------------------------------------------------

	const cancel = (id: string, reason?: string): boolean => {
		const entry = entries.get(id);
		return entry ? cancelEntry(entry, reason) : false;
	};

	const cancelByIdempotencyKey = (idempotencyKey: string, reason?: string): boolean => {
		const entry = [...entries.values()].find((candidate) => candidate.snapshot.idempotencyKey === idempotencyKey);
		return entry ? cancelEntry(entry, reason) : false;
	};

	const cancelAll = (reason = 'All requests cancelled'): void => {
		for (const entry of [...entries.values()]) cancelEntry(entry, reason);
	};

	const waitFor = async (idOrKey: string): Promise<unknown> => {
		let entry = findByIdOrKey(idOrKey);

		// the entry may still be coming from the storage adapter (restart
		// recovery), wait for restoration before giving up
		if (!entry) {
			await restored;
			entry = findByIdOrKey(idOrKey);
		}

		if (!entry || entry.status === 'succeeded') return entry?.settledResult;
		if (entry.status === 'failed') throw entry.settledError;

		return new Promise((resolve, reject) => {
			entry.waiters.push({ resolve, reject });
		});
	};

	const subscribeNetwork = () => {
		if (unsubscribeNetwork || !flushOnReconnect || typeof networkMonitor.subscribe !== 'function') return;

		unsubscribeNetwork = networkMonitor.subscribe((online) => {
			if (online && !paused && !destroyed) void flush();
		});
	};

	let unsubscribeUnload: (() => void) | null = null;

	const subscribeUnload = (queue: OfflineQueue) => {
		const destroyOnUnload =
			options.destroyOnUnload ??
			(typeof globalThis.addEventListener === 'function' && typeof document !== 'undefined');

		if (!destroyOnUnload || typeof globalThis.addEventListener !== 'function') return;

		const onPageHide = () => queue.destroy();
		globalThis.addEventListener('pagehide', onPageHide, { once: true });

		unsubscribeUnload = () => globalThis.removeEventListener('pagehide', onPageHide);
	};

	const queue: OfflineQueue = {
		enqueue,
		flush,
		cancel,
		cancelByIdempotencyKey,
		cancelAll,
		getEntries: () => [...entries.values()],
		waitFor,
		pause() {
			paused = true;
			unsubscribeNetwork?.();
			unsubscribeNetwork = null;
		},
		async resume() {
			paused = false;
			subscribeNetwork();
			if (networkMonitor.isOnline()) await flush();
		},
		destroy() {
			if (destroyed) return;

			destroyed = true;
			unsubscribeNetwork?.();
			unsubscribeNetwork = null;
			unsubscribeUnload?.();
			unsubscribeUnload = null;

			for (const timer of retryTimers) clearTimeout(timer);
			retryTimers.clear();

			// keep queued/in-flight snapshots in the injected storage so a
			// reload can recover them (in-flight ones are replayed; the
			// idempotency key prevents duplicates if the server received them)
			const persisted = [...entries.values()]
				.filter((entry) => entry.status === 'queued' || entry.status === 'flushing')
				.map((entry) => entry.snapshot);

			writeChain = writeChain.then(() => storage.set(persisted));

			for (const entry of [...entries.values()]) {
				if (entry.status === 'flushing') entry.abortController?.abort('Queue destroyed');
				if (entry.status === 'queued') {
					settleFailure(entry, new QueueCancellationError(entry.snapshot.id, 'Queue destroyed'));
				}
			}

			flushInProgress = null;
		},
	};

	// unload handling is attached synchronously so it works even if the page
	// is hidden before storage recovery finishes
	subscribeUnload(queue);

	// ---------------------------------------------------------------------
	// restore persisted entries (restart recovery), asynchronously
	// ---------------------------------------------------------------------

	Promise.resolve()
		.then(async () => {
			const restoredSnapshots = await storage.get();

			for (const snapshot of restoredSnapshots) {
				// drop duplicates that survived a crash while a newer entry
				// with the same idempotency key was persisted
				if (
					snapshot.idempotencyKey &&
					[...entries.values()].some((entry) => entry.snapshot.idempotencyKey === snapshot.idempotencyKey)
				) {
					continue;
				}

				entries.set(snapshot.id, createEntry(snapshot));
			}

			// release queued writes first; their snapshots are computed at
			// write time and therefore include the restored entries
			releaseWrites();

			// reconcile storage with the restored in-memory set
			await persist();

			subscribeNetwork();
			resolveRestored();

			// resolve before flushing: flush() awaits `restored`, so calling
			// it here would otherwise join its own unresolved promise
			if (networkMonitor.isOnline()) {
				Promise.resolve().then(() => void flush());
			}
		})
		.catch((error) => {
			options.hooks?.onError?.(undefined as unknown as QueueEntry, error);
			releaseWrites();
			subscribeNetwork();
			resolveRestored();
		});

	return { ...queue, restored };
};

/**
 * Creates an offline request queue and resolves once persisted entries have
 * been restored from the storage adapter.
 */
export const createOfflineQueue = async (options: InternalOfflineQueueOptions = {}): Promise<OfflineQueue> => {
	const queue = createOfflineQueueCore(options);
	await queue.restored;
	return queue;
};

const structuredCloneSafe = (value: Record<string, any> | undefined): Record<string, any> | undefined => {
	if (value === undefined) return undefined;
	return JSON.parse(JSON.stringify(value)) as Record<string, any>;
};

const cloneParams = structuredCloneSafe;
