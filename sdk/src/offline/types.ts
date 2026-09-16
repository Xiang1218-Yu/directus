import type { HttpMethod, RequestOptions } from '../types/request.js';
import type { ResponseTransformer, RequestTransformer } from '../types/request.js';

/**
 * Lifecycle state of a queued request.
 *
 * - `queued`: persisted, waiting to be flushed
 * - `flushing`: currently being replayed
 * - `succeeded`: completed, result available to current-session waiters
 * - `failed`: permanently rejected (validation error, retries exhausted, cancelled, ...)
 */
export type QueueEntryStatus = 'queued' | 'flushing' | 'succeeded' | 'failed';

/**
 * Serializable description of a request accepted by the queue.
 * Only values that survive a page reload are stored. Per-command `onRequest`/
 * `onResponse` transformers are functions and are therefore never persisted.
 */
export interface QueuedRequestSnapshot {
	id: string;
	/**
	 * Stable deduplication key. Queued requests sharing an idempotency key are
	 * submitted at most once while one of them is still queued or flushing.
	 */
	idempotencyKey: string | null;
	/** Ids of requests that must succeed before this request may be replayed. */
	dependsOn: string[];
	path: string;
	method: HttpMethod;
	params?: Record<string, any>;
	headers?: Record<string, string>;
	body?: string;
	/** Maximum number of replay attempts after network/server failures. */
	maxRetries: number;
	/** Number of failed attempts so far. Persisted to preserve the retry budget across restarts. */
	attempts: number;
	/** Monotonic creation order, used to keep a stable replay order. */
	createdAt: number;
}

/**
 * Storage adapter for the offline queue. The default implementation keeps
 * entries in memory; inject an adapter backed by `localStorage`, IndexedDB or
 * any other store to survive page reloads.
 */
export interface OfflineQueueStorage {
	get(): Promise<QueuedRequestSnapshot[]> | QueuedRequestSnapshot[];
	set(entries: QueuedRequestSnapshot[]): Promise<unknown> | unknown;
}

export type NetworkStatusListener = (online: boolean) => void;

/**
 * Abstraction over the environment's online/offline detection, so the queue
 * can be driven deterministically in tests and in non-browser environments.
 */
export interface NetworkMonitor {
	isOnline(): boolean;
	subscribe(listener: NetworkStatusListener): () => void;
}

/** Persisted snapshot together with the runtime state that cannot be serialized. */
export interface QueueEntry {
	snapshot: QueuedRequestSnapshot;
	status: QueueEntryStatus;
	/** Resolves or rejects when this entry settles. Lives for the current session only. */
	waiters: Array<{
		resolve: (value: unknown) => void;
		reject: (reason: unknown) => void;
	}>;
	/** Abort controllers for in-flight replays. A new one is created per attempt. */
	abortController: AbortController | null;
	/** Per-command hooks of the originating session, lost after a restart. */
	commandHooks?: {
		onRequest?: RequestTransformer;
		onResponse?: ResponseTransformer;
	};
}

/**
 * Receives an entry that is ready to be sent and executes the actual request.
 * The composable wires this to the REST request pipeline; it is also the seam
 * where single-flight token refresh on auth errors happens.
 */
export type QueueExecutor = (
	entry: QueueEntry,
	signal: AbortSignal,
) => Promise<unknown>;

/**
 * Called once per flush cycle when an entry fails with an authentication error.
 * Returning a promise allows replaying the request after a token refresh;
 * rejecting marks the entry as permanently failed with the auth error.
 */
export type AuthRefreshHandler = (error: unknown) => Promise<void>;

export type RetryDelayFn = (attempt: number) => number;

/** Callback hooks for observing queue activity (telemetry, UI badges, ...). */
export interface QueueEventHooks {
	onEnqueue?(entry: QueueEntry): void;
	onReplay?(entry: QueueEntry, attempt: number): void;
	onSuccess?(entry: QueueEntry, result: unknown): void;
	onError?(entry: QueueEntry, error: unknown): void;
	onCancel?(entry: QueueEntry): void;
}

export interface OfflineQueueOptions {
	storage?: OfflineQueueStorage;
	networkMonitor?: NetworkMonitor;
	executor?: QueueExecutor;
	onAuthRefresh?: AuthRefreshHandler;
	/** Maximum number of retries for network errors and 5xx responses. Defaults to 3. */
	maxRetries?: number;
	/** Backoff in ms before the given 1-based attempt. Defaults to exponential with jitter. */
	retryDelay?: RetryDelayFn;
	/** Flush automatically when the network monitor reports connectivity. Defaults to true. */
	flushOnReconnect?: boolean;
	hooks?: QueueEventHooks;
}

/** Per-request overrides accepted when enqueuing. */
export interface EnqueueOptions {
	/**
	 * Custom idempotency key. When provided the `Idempotency-Key` header is sent
	 * and duplicate submissions while queued are collapsed. When omitted one is
	 * generated automatically for safe methods.
	 */
	idempotencyKey?: string;
	/** Ids (or idempotency keys) of requests this one depends on. */
	dependsOn?: string[];
	maxRetries?: number;
}

/**
 * Promise returned for a queued request. Resolves with the normal SDK result
 * (same type `client.request` would resolve with) and rejects with the same
 * error types, plus the queue errors for cancellation and exhausted retries.
 */
export interface QueuedRequest<T> extends Promise<T> {
	/** Unique queue id of this request. */
	readonly id: string;
	/** Idempotency key this request is deduplicated by, if any. */
	readonly idempotencyKey: string | null;
	/** Aborts an in-flight replay or removes the request from the queue. */
	cancel(reason?: string): void;
}

export interface OfflineQueue {
	/** Queue a command for (re)execution. */
	enqueue<T = unknown>(options: RequestOptions, enqueueOptions?: EnqueueOptions): QueuedRequest<T>;
	/** Replay all eligible queued requests in dependency order. Single-flight. */
	flush(): Promise<void>;
	/** Cancel a single queued request by queue id. */
	cancel(id: string, reason?: string): boolean;
	/** Cancel a queued request by its idempotency key. */
	cancelByIdempotencyKey(idempotencyKey: string, reason?: string): boolean;
	/** Cancel all queued requests. */
	cancelAll(reason?: string): void;
	/** Snapshot of currently queued/in-flight requests. */
	getEntries(): readonly QueueEntry[];
	/** Resolves once a request with the given id or idempotency key settles. */
	waitFor(idOrKey: string): Promise<unknown>;
	/** Stop reacting to network events (retrying continues for active flushes). */
	pause(): void;
	/** Re-subscribe to network events and flush if online. */
	resume(): Promise<void>;
	/** Unsubscribe listeners, clear timers and reject pending session promises. */
	destroy(): void;
}
