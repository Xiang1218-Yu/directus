import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestError } from '../utils/error.js';
import {
	QueueCancellationError,
	QueueDependencyError,
	QueueRejectedError,
	QueueRetryExhaustedError,
} from './errors.js';
import { createOfflineQueueCore } from './offline-queue.js';
import { memoryQueueStorage, webStorageQueueAdapter } from './storage.js';
import { staticNetworkMonitor } from './network.js';
import type { ExecutorLike } from './test-utils.js';
import { makeRequestError } from './test-utils.js';
import type { OfflineQueueStorage, QueuedRequestSnapshot } from './types.js';

type Executor = ExecutorLike;

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const createdQueues: Array<ReturnType<typeof createOfflineQueueCore>> = [];

afterEach(() => {
	for (const queue of createdQueues.splice(0)) queue.destroy();
});

const createQueue = (
	executor: Executor,
	overrides: Partial<Parameters<typeof createOfflineQueueCore>[0]> = {},
) => {
	const queue = createOfflineQueueCore({
		networkMonitor: staticNetworkMonitor(true),
		retryDelay: () => 0,
		maxRetries: 3,
		flushOnReconnect: false,
		...overrides,
		executor,
	});
	createdQueues.push(queue);
	return queue;
};

describe('offline queue core', () => {
	it('replays queued requests in creation order when online', async () => {
		const order: string[] = [];
		const executor: Executor = async (entry) => {
			order.push(entry.snapshot.path);
			return `done:${entry.snapshot.path}`;
		};

		const queue = createQueue(executor);
		await queue.restored;

		const a = queue.enqueue({ path: '/items/a', method: 'PUT', body: '{}' }, { idempotencyKey: 'a' });
		const b = queue.enqueue({ path: '/items/b', method: 'PUT', body: '{}' }, { idempotencyKey: 'b' });

		await expect(Promise.all([a, b])).resolves.toEqual(['done:/items/a', 'done:/items/b']);
		expect(order).toEqual(['/items/a', '/items/b']);
		expect(queue.getEntries()).toHaveLength(0);
	});

	it('replays in dependency order rather than insertion order', async () => {
		const order: string[] = [];
		const executor: Executor = async (entry) => {
			order.push(entry.snapshot.id);
			return entry.snapshot.id;
		};

		const queue = createQueue(executor);
		await queue.restored;

		const dep = queue.enqueue(
			{ path: '/items/x', method: 'PATCH', body: '{}' },
			{ idempotencyKey: 'parent' },
		);

		const child = queue.enqueue(
			{ path: '/items/y', method: 'PATCH', body: '{}' },
			{ idempotencyKey: 'child', dependsOn: ['parent'] },
		);

		await Promise.all([dep, child]);
		expect(order[0]).toBe(dep.id);
		expect(order[1]).toBe(child.id);
	});

	it('does not send requests while offline and flushes once connectivity returns', async () => {
		const executor = vi.fn(async () => 'ok');
		const monitor = staticNetworkMonitor(false);
		const queue = createQueue(executor, {
			networkMonitor: monitor,
			flushOnReconnect: false,
		});
		await queue.restored;

		const pending = queue.enqueue({ path: '/items/a', method: 'PUT', body: '{}' }, { idempotencyKey: 'k' });

		await tick(5);
		expect(executor).not.toHaveBeenCalled();
		expect(queue.getEntries()[0]?.status).toBe('queued');

		monitor.setOnline(true);
		await queue.flush();

		await expect(pending).resolves.toBe('ok');
		expect(executor).toHaveBeenCalledTimes(1);
	});

	it('auto-flushes on reconnect when flushOnReconnect is enabled (default)', async () => {
		const executor = vi.fn(async () => 'ok');
		const monitor = staticNetworkMonitor(false);
		const queue = createQueue(executor, {
			networkMonitor: monitor,
			flushOnReconnect: true,
		});
		await queue.restored;

		const pending = queue.enqueue({ path: '/items/a', method: 'PUT', body: '{}' }, { idempotencyKey: 'k' });
		await tick(5);
		expect(executor).not.toHaveBeenCalled();

		monitor.setOnline(true);
		await expect(pending).resolves.toBe('ok');
		expect(executor).toHaveBeenCalledTimes(1);
	});

	describe('duplicate submissions', () => {
		it('collapses concurrent submissions with the same idempotency key', async () => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const executor = vi.fn(
				async () =>
					new Promise((resolve) => {
						gate.then(() => resolve('created'));
					}),
			);

			const queue = createQueue(executor);
			await queue.restored;

			const first = queue.enqueue(
				{ path: '/items/a', method: 'POST', body: '{"x":1}' },
				{ idempotencyKey: 'dup' },
			);
			await tick();

			const second = queue.enqueue(
				{ path: '/items/a', method: 'POST', body: '{"x":1}' },
				{ idempotencyKey: 'dup' },
			);

			expect(second.id).toBe(first.id);
			release();
			await expect(Promise.all([first, second])).resolves.toEqual(['created', 'created']);
			expect(executor).toHaveBeenCalledTimes(1);
		});

		it('allows reusing an idempotency key after the request settled', async () => {
			const executor = vi.fn(async () => 'ok');
			const queue = createQueue(executor);
			await queue.restored;

			await queue.enqueue({ path: '/items/a', method: 'POST', body: '{}' }, { idempotencyKey: 'once' });
			await queue.flush();

			const again = queue.enqueue({ path: '/items/a', method: 'POST', body: '{}' }, { idempotencyKey: 'once' });
			await again;

			expect(executor).toHaveBeenCalledTimes(2);
		});

		it('sends the Idempotency-Key header but never persists the Authorization header', async () => {
			const storage = memoryQueueStorage();
			const executor = vi.fn(async () => 'ok');
			const monitor = staticNetworkMonitor(false);
			const queue = createQueue(executor, { storage, networkMonitor: monitor });
			await queue.restored;

			queue
				.enqueue(
					{
						path: '/items/a',
						method: 'PATCH',
						body: '{}',
						headers: { Authorization: 'Bearer secret-token' },
					},
					{ idempotencyKey: 'key-1' },
				)
				.catch(() => {
					/* destroyed in afterEach */
				});

			await tick();
			const persisted = await storage.get();
			expect(persisted[0]?.headers?.['Idempotency-Key']).toBe('key-1');
			expect(persisted[0]?.headers?.['Authorization']).toBeUndefined();
		});
	});

	describe('restart recovery', () => {
		const snapshot = (over: Partial<QueuedRequestSnapshot> = {}): QueuedRequestSnapshot => ({
			id: 'restored-id',
			idempotencyKey: 'restored-key',
			dependsOn: [],
			path: '/items/a',
			method: 'PATCH',
			body: '{"x":1}',
			headers: { 'Idempotency-Key': 'restored-key' },
			maxRetries: 2,
			attempts: 0,
			createdAt: 1,
			...over,
		});

		it('restores persisted entries and replays them once', async () => {
			let stored: QueuedRequestSnapshot[] = [snapshot()];
			const storage: OfflineQueueStorage = {
				get: vi.fn(async () => stored),
				set: vi.fn(async (entries) => {
					stored = entries;
				}),
			};
			const executor = vi.fn(async (entry) => `result:${entry.snapshot.id}`);
			const queue = createQueue(executor, { storage });

			const result = await queue.waitFor('restored-id');
			expect(result).toBe('result:restored-id');
			expect(executor).toHaveBeenCalledTimes(1);
			await queue.flush();
			expect(storage.set).toHaveBeenLastCalledWith([]);
			expect(stored).toEqual([]);
		});

		it('dedupes restored snapshots that share an idempotency key', async () => {
			const storage = memoryQueueStorage();
			await storage.set([snapshot({ id: 'a' }), snapshot({ id: 'b' })]);
			const executor = vi.fn(async () => 'ok');

			const queue = createQueue(executor, { storage });
			await queue.restored;
			await queue.flush();

			expect(executor).toHaveBeenCalledTimes(1);
		});

		it('persists failed attempts so the retry budget survives a restart', async () => {
			const storage = memoryQueueStorage();
			await storage.set([snapshot({ attempts: 2, maxRetries: 2 })]);
			const networkError = new TypeError('Failed to fetch');
			const executor = vi.fn(async () => {
				throw networkError;
			});

			const queue = createQueue(executor, { storage });

			await expect(queue.waitFor('restored-id')).rejects.toBeInstanceOf(QueueRetryExhaustedError);
			// attempts was already 2, maxRetries 2 -> only one more send is allowed
			expect(executor).toHaveBeenCalledTimes(1);
		});

		it('works with a web storage adapter (localStorage-like)', async () => {
			const map = new Map<string, string>();
			const webStorage = {
				getItem: (key: string) => map.get(key) ?? null,
				setItem: (key: string, value: string) => void map.set(key, value),
				removeItem: (key: string) => void map.delete(key),
			};

			const adapter = webStorageQueueAdapter(webStorage);
			await adapter.set([snapshot()]);

			const executor = vi.fn(async () => 'ok');
			const queue = createQueue(executor, { storage: adapter });
			await queue.restored;
			await queue.flush();

			expect(executor).toHaveBeenCalledTimes(1);
			expect(map.has('directus-offline-queue')).toBe(false);
		});
	});

	describe('concurrent flush', () => {
		it('single-flights concurrent flush() calls', async () => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const onReplay = vi.fn();
			const executor = vi.fn(
				async () =>
					new Promise((resolve) => {
						gate.then(() => resolve('ok'));
					}),
			);

			const queue = createQueue(executor, { hooks: { onReplay } });
			await queue.restored;

			queue
				.enqueue({ path: '/items/a', method: 'PUT', body: '{}' }, { idempotencyKey: 'a' })
				.catch(() => {
					/* never settles: gate is not released */
				});
			await tick();

			const flushes = await Promise.all([
				queue.flush().then((value) => value),
				queue.flush().then((value) => value),
				queue.flush().then((value) => value),
			]);
			expect(flushes).toEqual([undefined, undefined, undefined]);

			release();
			await tick();

			expect(executor).toHaveBeenCalledTimes(1);
			expect(onReplay).toHaveBeenCalledTimes(1);
		});
	});

	describe('retries', () => {
		it('retries network errors up to maxRetries then rejects with the wrapped error', async () => {
			const executor = vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			});

			const queue = createQueue(executor, { maxRetries: 2, retryDelay: () => 0 });
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'PUT', body: '{}' }, { idempotencyKey: 'k' });

			await expect(request).rejects.toBeInstanceOf(QueueRetryExhaustedError);
			expect(executor).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
		});

		it('does not retry 4xx validation errors', async () => {
			const error = makeRequestError(422, 'FAILED_VALIDATION');
			const executor = vi.fn(async () => {
				throw error;
			});

			const queue = createQueue(executor);
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'POST', body: '{}' }, { idempotencyKey: 'k' });
			await expect(request).rejects.toBe(error);
			expect(executor).toHaveBeenCalledTimes(1);
		});

		it('retries 5xx server errors', async () => {
			let calls = 0;
			const executor = vi.fn(async () => {
				calls++;
				if (calls === 1) throw makeRequestError(503, 'SERVICE_UNAVAILABLE');
				return 'recovered';
			});

			const queue = createQueue(executor, { retryDelay: () => 0 });
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'PUT', body: '{}' }, { idempotencyKey: 'k' });
			await expect(request).resolves.toBe('recovered');
			expect(executor).toHaveBeenCalledTimes(2);
		});

		it('records the real number of request attempts in the snapshot', async () => {
			const seenAttempts: number[] = [];
			const executor = vi.fn(async (entry) => {
				seenAttempts.push(entry.snapshot.attempts);
				throw new TypeError('offline');
			});

			const queue = createQueue(executor, { maxRetries: 1, retryDelay: () => 0 });
			await queue.restored;

			queue
				.enqueue({ path: '/items/a', method: 'PUT', body: '{}' }, { idempotencyKey: 'k' })
				.catch(() => {
					/* asserted via waitFor below */
				});
			await expect(queue.waitFor('k')).rejects.toBeInstanceOf(QueueRetryExhaustedError);
			expect(seenAttempts).toEqual([0, 1]);
		});
	});

	describe('cancellation', () => {
		it('cancels a queued request without sending it', async () => {
			const monitor = staticNetworkMonitor(false);
			const executor = vi.fn(async () => 'ok');
			const queue = createQueue(executor, { networkMonitor: monitor });
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' }, { idempotencyKey: 'k' });
			await tick();

			expect(queue.cancel(request.id)).toBe(true);
			await expect(request).rejects.toBeInstanceOf(QueueCancellationError);
			expect(executor).not.toHaveBeenCalled();
			expect(queue.getEntries()).toEqual([]);
			expect(queue.cancel(request.id)).toBe(false);
		});

		it('aborts an in-flight replay through AbortController', async () => {
			const executor = vi.fn(
				async (_entry, signal) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener('abort', () => {
							reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
						});
					}),
			);

			const queue = createQueue(executor);
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'PUT', body: '{}' }, { idempotencyKey: 'k' });
			await tick();

			expect(queue.cancel(request.id)).toBe(true);
			await expect(request).rejects.toBeInstanceOf(QueueCancellationError);
		});

		it('cancels via the returned promise and by idempotency key', async () => {
			const monitor = staticNetworkMonitor(false);
			const executor = vi.fn(async () => 'ok');
			const queue = createQueue(executor, { networkMonitor: monitor });
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' }, { idempotencyKey: 'key-xyz' });
			await tick();

			expect(queue.cancelByIdempotencyKey('key-xyz')).toBe(true);
			await expect(request).rejects.toBeInstanceOf(QueueCancellationError);

			const other = queue.enqueue({ path: '/items/b', method: 'PATCH', body: '{}' }, { idempotencyKey: 'key-2' });
			other.cancel('manual');
			await expect(other).rejects.toThrow('manual');
		});

		it('keeps cancelled requests out of persistence', async () => {
			const storage = memoryQueueStorage();
			const monitor = staticNetworkMonitor(false);
			const queue = createQueue(vi.fn(), { networkMonitor: monitor, storage });
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' }, { idempotencyKey: 'k' });
			await tick();
			const cancellation = expect(request).rejects.toBeInstanceOf(QueueCancellationError);
			request.cancel();
			await cancellation;
			await tick();

			expect(await storage.get()).toEqual([]);
		});
	});

	describe('dependencies', () => {
		it('fails dependents when their prerequisite fails', async () => {
			const executor = vi.fn(async (entry) => {
				if (entry.snapshot.idempotencyKey === 'parent') throw makeRequestError(400);
				return 'ok';
			});

			const queue = createQueue(executor);
			await queue.restored;

			const parent = queue.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' }, { idempotencyKey: 'parent' });
			const child = queue.enqueue(
				{ path: '/items/b', method: 'PATCH', body: '{}' },
				{ idempotencyKey: 'child', dependsOn: ['parent'] },
			);

			await expect(parent).rejects.toBeInstanceOf(RequestError);
			await expect(child).rejects.toBeInstanceOf(QueueDependencyError);
			// child must never have been sent
			expect(executor).toHaveBeenCalledTimes(1);
		});
	});

	describe('enqueue guards', () => {
		it('rejects FormData uploads by default', async () => {
			const queue = createQueue(vi.fn());
			await queue.restored;

			const form = new FormData();
			form.append('file', new Blob(['x']), 'x.txt');

			expect(() =>
				queue.enqueue({ path: '/files/import', method: 'POST', body: form }, { idempotencyKey: 'k' }),
			).toThrowError(QueueRejectedError);
		});

		it('rejects POST/PATCH without an idempotency key by default', async () => {
			const queue = createQueue(vi.fn());
			await queue.restored;

			expect(() => queue.enqueue({ path: '/items/a', method: 'POST', body: '{}' })).toThrowError(QueueRejectedError);
			expect(() => queue.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' })).toThrowError(QueueRejectedError);
		});

		it('accepts PUT/DELETE and reads without a key, and unkeyed mutations when allowed', async () => {
			const executor = vi.fn(async () => 'ok');
			const queue = createQueue(executor, { allowNonIdempotent: true });
			await queue.restored;

			await expect(queue.enqueue({ path: '/items/a', method: 'PUT', body: '{}' })).resolves.toBe('ok');
			await expect(queue.enqueue({ path: '/items/a', method: 'DELETE' })).resolves.toBe('ok');
			await expect(queue.enqueue({ path: '/items/a' })).resolves.toBe('ok');
			await expect(queue.enqueue({ path: '/items/a', method: 'POST', body: '{}' })).resolves.toBe('ok');
		});
	});

	describe('token refresh', () => {
		it('refreshes once per flush cycle and replays after refresh', async () => {
			const seen = new Set<string>();
			const executor = vi.fn(async (entry) => {
				// first attempt of each request is 401; after refresh all succeed
				if (!seen.has(entry.snapshot.idempotencyKey!)) {
					seen.add(entry.snapshot.idempotencyKey!);
					throw makeRequestError(401, 'TOKEN_EXPIRED');
				}

				return 'authorized';
			});
			const onAuthRefresh = vi.fn(async () => {
				await Promise.resolve();
			});

			const queue = createQueue(executor, { onAuthRefresh });
			await queue.restored;

			const a = queue.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' }, { idempotencyKey: 'a' });
			const b = queue.enqueue({ path: '/items/b', method: 'PATCH', body: '{}' }, { idempotencyKey: 'b' });

			await expect(Promise.all([a, b])).resolves.toEqual(['authorized', 'authorized']);
			expect(onAuthRefresh).toHaveBeenCalledTimes(1);
			// each entry sent once pre-refresh and once post-refresh
			expect(executor).toHaveBeenCalledTimes(4);
		});

		it('settles with the original RequestError when refresh fails', async () => {
			const error = makeRequestError(401, 'TOKEN_EXPIRED');
			const executor = vi.fn(async () => {
				throw error;
			});
			const onAuthRefresh = vi.fn(async () => {
				throw new Error('refresh token expired');
			});

			const queue = createQueue(executor, { onAuthRefresh });
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' }, { idempotencyKey: 'k' });
			await expect(request).rejects.toBe(error);
			// original attempt only; no replay after failed refresh
			expect(executor).toHaveBeenCalledTimes(1);
		});

		it('single-flights a refresh shared by entries in the same flush cycle', async () => {
			const seen = new Set<string>();
			const executor = vi.fn(async (entry) => {
				// first attempt of each entry is 401; retries after refresh succeed
				if (!seen.has(entry.snapshot.id)) {
					seen.add(entry.snapshot.id);
					throw makeRequestError(401);
				}

				return 'ok';
			});
			const onAuthRefresh = vi.fn(async () => {
				await tick(0);
			});

			const queue = createQueue(executor, { onAuthRefresh });
			await queue.restored;

			const requests = ['a', 'b', 'c'].map((idempotencyKey) =>
				queue.enqueue({ path: `/items/${idempotencyKey}`, method: 'PATCH', body: '{}' }, { idempotencyKey }),
			);

			await Promise.all(requests);
			expect(onAuthRefresh).toHaveBeenCalledTimes(1);
			// 3 initial attempts (all 401) + 3 replays after refresh
			expect(executor).toHaveBeenCalledTimes(6);
		});
	});

	describe('page unload', () => {
		it('destroys on pagehide but keeps entries recoverable from storage', async () => {
			const listeners = new Map<string, EventListener>();
			const addSpy = vi.fn((type: string, listener: EventListener) => {
				listeners.set(type, listener);
			});
			const removeSpy = vi.fn((type: string) => {
				listeners.delete(type);
			});
			const globalScope = globalThis as unknown as Record<string, unknown>;
			const originalAdd = globalScope.addEventListener;
			const originalRemove = globalScope.removeEventListener;
			globalScope.addEventListener = addSpy;
			globalScope.removeEventListener = removeSpy;

			const storage = memoryQueueStorage();
			const monitor = staticNetworkMonitor(false);
			const executor = vi.fn(async () => 'ok');
			const queue = createQueue(executor, {
				storage,
				networkMonitor: monitor,
				flushOnReconnect: false,
				destroyOnUnload: true,
			});
			await queue.restored;

			const request = queue
				.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' }, { idempotencyKey: 'unload-1' })
				.catch((reason) => reason);

			await tick();
			expect(addSpy).toHaveBeenCalledWith('pagehide', expect.any(Function), { once: true });

			listeners.get('pagehide')!(new Event('pagehide'));
			await expect(request).resolves.toBeInstanceOf(QueueCancellationError);
			expect(removeSpy).toHaveBeenCalledWith('pagehide', expect.any(Function));

			// entries survive for a reload
			const recovered = createQueue(vi.fn(async () => 'recovered'), {
				storage,
				networkMonitor: staticNetworkMonitor(true),
			});
			await expect(recovered.waitFor('unload-1')).resolves.toBe('recovered');

			(globalThis as unknown as Record<string, unknown>).addEventListener = originalAdd;
			(globalThis as unknown as Record<string, unknown>).removeEventListener = originalRemove;
		});
	});

	describe('destroy', () => {
		it('rejects queued promises, aborts in-flight requests but keeps persistence', async () => {
			const storage = memoryQueueStorage();
			const monitor = staticNetworkMonitor(false);
			const executor = vi.fn(async () => 'ok');
			const queue = createQueue(executor, { networkMonitor: monitor, storage });
			await queue.restored;

			const request = queue.enqueue({ path: '/items/a', method: 'PATCH', body: '{}' }, { idempotencyKey: 'k' });
			await tick();

			queue.destroy();
			await expect(request).rejects.toBeInstanceOf(QueueCancellationError);

			const persisted = await storage.get();
			expect(persisted).toHaveLength(1);
			expect(persisted[0]?.idempotencyKey).toBe('k');

			// a new queue (page reload) recovers the entry
			const executor2 = vi.fn(async () => 'recovered');
			const recreated = createQueue(executor2, {
				storage,
				networkMonitor: staticNetworkMonitor(true),
			});
			await expect(recreated.waitFor('k')).resolves.toBe('recovered');
		});
	});
});
