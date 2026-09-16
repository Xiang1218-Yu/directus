import type { AuthenticationClient } from '../auth/types.js';
import type { DirectusClient } from '../types/client.js';
import type { RequestOptions } from '../types/request.js';
import type { RestConfig } from '../rest/types.js';
import { executeRestRequest } from '../rest/utils/execute-rest-request.js';
import { createOfflineQueueCore, type InternalOfflineQueueOptions } from './offline-queue.js';
import type { EnqueueOptions, OfflineQueue, QueueEntry, QueuedRequest } from './types.js';

/**
 * Configuration for the optional offline request queue composable. The queue
 * storage, network monitor, retry behavior and event hooks are accepted, and
 * queueing of uploads/unkeyed non-idempotent requests stays opt-in.
 */
export type OfflineConfig = Omit<InternalOfflineQueueOptions, 'executor' | 'onAuthRefresh'> & {
	/** Forwarded to the REST request pipeline (e.g. `'include'` for cookie auth). */
	credentials?: RequestCredentials;
	/** Global request hook, applied on every replay. */
	onRequest?: RestConfig['onRequest'];
	/** Global response hook, applied on every replay. */
	onResponse?: RestConfig['onResponse'];
};

/**
 * Client extension returned by the `offline()` composable.
 */
export interface OfflineClient<Schema> extends OfflineQueue {
	/**
	 * Queue a REST command. Identical return and error types to `rest()`'s
	 * `request()`, with the additional `id`/`idempotencyKey`/`cancel` surface
	 * on the returned promise.
	 */
	requestQueued<Output>(getOptions: () => RequestOptions, enqueueOptions?: EnqueueOptions): QueuedRequest<Output>;
}

/**
 * Optional composable that adds an offline request queue on top of the REST
 * and authentication composables:
 *
 * ```ts
 * const client = createDirectus<Schema>(url)
 *   .with(authentication('json'))
 *   .with(rest())
 *   .with(offline({ storage: webStorageQueueAdapter(localStorage) }));
 *
 * const queued = client.requestQueued(updateItem('articles', 1, { title }), {
 *   idempotencyKey: 'article-1-title-v1',
 *   dependsOn: ['article-1'],
 * });
 * ```
 *
 * Requests marked queueable via `requestQueued` are persisted while offline
 * and replayed once connectivity returns, in dependency order, with
 * deduplication via idempotency keys, bounded retries, cancellation and a
 * single-flight token refresh on authentication errors.
 *
 * File uploads (`FormData`) and unkeyed non-idempotent requests (POST/PATCH)
 * are rejected at enqueue time unless explicitly allowed.
 *
 * The returned client is usable immediately; entries restored from the
 * storage adapter are replayed in the background once recovery is finished.
 */
export const offline = (config: OfflineConfig = {}) => {
	return <Schema>(client: DirectusClient<Schema>): OfflineClient<Schema> => {
		const restConfig: Partial<RestConfig> = {};
		if (config.credentials !== undefined) restConfig.credentials = config.credentials;
		if (config.onRequest !== undefined) restConfig.onRequest = config.onRequest;
		if (config.onResponse !== undefined) restConfig.onResponse = config.onResponse;

		// The factory receives the composed client built so far. Methods
		// invoked on the final composed object late-bind it here, so
		// authentication composed after offline() is picked up as well.
		let liveTarget: object = client as object;

		const executor = async (entry: QueueEntry, signal: AbortSignal): Promise<unknown> => {
			const { snapshot } = entry;

			const options: RequestOptions = {
				path: snapshot.path,
				method: snapshot.method,
				params: snapshot.params,
				headers: { ...(snapshot.headers ?? {}) },
				body: snapshot.body,
				signal,
				...entry.commandHooks,
			};

			return executeRestRequest(
				client,
				liveTarget as Parameters<typeof executeRestRequest>[1],
				options,
				restConfig as RestConfig,
				restConfig,
			);
		};

		const onAuthRefresh = async (error: unknown): Promise<void> => {
			const source = liveTarget as Partial<AuthenticationClient<Schema>>;

			if (typeof source.refresh === 'function') {
				await source.refresh.call(liveTarget as AuthenticationClient<Schema>);
				return;
			}

			// no authentication composable available: keep the original
			// RequestError rather than masking it
			throw error;
		};

		const queue = createOfflineQueueCore({ ...config, executor, onAuthRefresh });

		return {
			requestQueued<Output>(this: object, getOptions: () => RequestOptions, enqueueOptions?: EnqueueOptions) {
				liveTarget = this;
				return queue.enqueue<Output>(getOptions(), enqueueOptions);
			},
			enqueue(this: object, ...args: Parameters<OfflineQueue['enqueue']>) {
				liveTarget = this;
				return queue.enqueue(...args);
			},
			flush: () => queue.flush(),
			cancel: (...args: Parameters<OfflineQueue['cancel']>) => queue.cancel(...args),
			cancelByIdempotencyKey: (...args: Parameters<OfflineQueue['cancelByIdempotencyKey']>) =>
				queue.cancelByIdempotencyKey(...args),
			cancelAll: (...args: Parameters<OfflineQueue['cancelAll']>) => queue.cancelAll(...args),
			getEntries: () => queue.getEntries(),
			waitFor: (...args: Parameters<OfflineQueue['waitFor']>) => queue.waitFor(...args),
			pause: () => queue.pause(),
			resume: () => queue.resume(),
			destroy: () => queue.destroy(),
		} as unknown as OfflineClient<Schema>;
	};
};
