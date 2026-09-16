import { afterEach, describe, expect, it, vi } from 'vitest';
import { authentication } from '../auth/composable.js';
import { memoryStorage } from '../auth/utils/memory-storage.js';
import { createDirectus } from '../client.js';
import { rest } from '../rest/composable.js';
import { memoryQueueStorage } from './storage.js';
import { staticNetworkMonitor } from './network.js';
import { offline } from './composable.js';
import { RequestError } from '../utils/error.js';
import { QueueCancellationError, QueueRejectedError, QueueRetryExhaustedError } from './errors.js';

type FetchMock = ReturnType<typeof vi.fn>;

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

const jsonResponse = (body: unknown, init: { status?: number } = {}) => {
	const status = init.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: new Headers([['Content-Type', 'application/json']]),
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
};

import type { OfflineClient } from './composable.js';

type TestClient = OfflineClient<any> & {
	setToken(token: string | null): Promise<unknown>;
};

const clients: TestClient[] = [];

afterEach(() => {
	for (const client of clients.splice(0)) client.destroy();
});

const buildClient = (
	fetchMock: FetchMock,
	offlineOverrides: Parameters<typeof offline>[0] = {},
): TestClient => {
	const base = createDirectus('https://example.com', {
		globals: {
			fetch: fetchMock as unknown as typeof fetch,
			WebSocket: (class {
				static readonly CONNECTING = 0;
				static readonly OPEN = 1;
				static readonly CLOSING = 2;
				static readonly CLOSED = 3;
			}) as unknown as typeof WebSocket,
			URL,
			logger: console,
		},
	});

	const client = base
		.with(authentication('json', { storage: memoryStorage(), autoRefresh: false }))
		.with(rest())
		.with(
			offline({
				networkMonitor: staticNetworkMonitor(true),
				retryDelay: () => 0,
				maxRetries: 1,
				...offlineOverrides,
			}),
		);

	clients.push(client);
	return client;
};

describe('offline() composable', () => {
	it('replays through the REST pipeline and preserves the SDK return type', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ data: { id: 7, title: 'saved' } }));
		const client = buildClient(fetchMock);

		const promise = client.requestQueued(
			() => ({
				path: '/items/articles/7',
				method: 'PATCH',
				body: JSON.stringify({ title: 'saved' }),
			}),
			{ idempotencyKey: 'art-7' },
		);

		const result = (await promise) as { id: number; title: string };
		expect(result).toEqual({ id: 7, title: 'saved' });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(String(url)).toBe('https://example.com/items/articles/7');
		expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('art-7');
	});

	it('rejects FormData and unkeyed POST by default', async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ data: null }));
		const client = buildClient(fetchMock);

		const form = new FormData();
		form.append('file', new Blob(['x']), 'x.txt');

		expect(() =>
			client.requestQueued(() => ({ path: '/files/import', method: 'POST', body: form }), {
				idempotencyKey: 'up',
			}),
		).toThrowError(QueueRejectedError);

		expect(() => client.requestQueued(() => ({ path: '/items/a', method: 'POST', body: '{}' }))).toThrowError(
			QueueRejectedError,
		);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('distinguishes validation (4xx) errors from network errors without retry', async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse(
				{
					errors: [
						{ message: 'Validation failed', extensions: { code: 'FAILED_VALIDATION' } },
					],
				},
				{ status: 422 },
			),
		);

		const client = buildClient(fetchMock);
		const promise = client.requestQueued(
			() => ({ path: '/items/articles', method: 'POST', body: '{}' }),
			{ idempotencyKey: 'invalid' },
		);

		const error = await promise.then(
			() => {
				throw new Error('expected rejection');
			},
			(reason: unknown) => reason,
		);

		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).response.status).toBe(422);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('retries network errors, exhausts the budget and rejects with the wrapped error', async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});

		const client = buildClient(fetchMock, { maxRetries: 1, retryDelay: () => 0 });
		const promise = client.requestQueued(
			() => ({ path: '/items/a', method: 'PATCH', body: '{}' }),
			{ idempotencyKey: 'net' },
		);

		await expect(promise).rejects.toBeInstanceOf(QueueRetryExhaustedError);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('queues offline and flushes on reconnect, sending the request exactly once', async () => {
		const monitor = staticNetworkMonitor(false);
		const fetchMock = vi.fn(async () => jsonResponse({ data: { ok: true } }));
		const client = buildClient(fetchMock, { networkMonitor: monitor, flushOnReconnect: false });

		const promise = client.requestQueued(
			() => ({ path: '/items/a', method: 'PATCH', body: '{}' }),
			{ idempotencyKey: 'offline-1' },
		);

		await tick(5);
		expect(fetchMock).not.toHaveBeenCalled();

		monitor.setOnline(true);
		await client.flush();

		await expect(promise).resolves.toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('single-flights concurrent flush() calls against the REST pipeline', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchMock = vi.fn(
			async () => new Promise((resolve) => gate.then(() => resolve(jsonResponse({ data: 'ok' })))),
		);
		const client = buildClient(fetchMock);

		const promise = client.requestQueued(
			() => ({ path: '/items/a', method: 'PUT', body: '{}' }),
			{ idempotencyKey: 'flush-1' },
		);

		await tick();
		const flushes = await Promise.all([client.flush(), client.flush(), client.flush()]);
		expect(flushes).toEqual([undefined, undefined, undefined]);

		release();
		await expect(promise).resolves.toBe('ok');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('cancels a queued request', async () => {
		const monitor = staticNetworkMonitor(false);
		const fetchMock = vi.fn(async () => jsonResponse({ data: null }));
		const client = buildClient(fetchMock, { networkMonitor: monitor });

		const promise = client.requestQueued(
			() => ({ path: '/items/a', method: 'PATCH', body: '{}' }),
			{ idempotencyKey: 'cancel-1' },
		);

		promise.cancel('user navigated away');
		await expect(promise).rejects.toBeInstanceOf(QueueCancellationError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('recovers queued requests from persistence after a restart (new client)', async () => {
		const storage = memoryQueueStorage();
		const offlineMonitor = staticNetworkMonitor(false);

		const first = buildClient(vi.fn(async () => jsonResponse({ data: null })), {
			storage,
			networkMonitor: offlineMonitor,
			flushOnReconnect: false,
		});

		const request = first.requestQueued(
			() => ({ path: '/items/articles/1', method: 'PATCH', body: JSON.stringify({ title: 'later' }) }),
			{ idempotencyKey: 'recover-1' },
		);

		await tick(5);
		expect((await storage.get())[0]?.idempotencyKey).toBe('recover-1');

		// simulate page unload: destroy rejects session promises but keeps persistence
		first.destroy();
		await expect(request).rejects.toBeInstanceOf(QueueCancellationError);

		// simulate reload: a fresh client restores and replays exactly once
		const fetchMock2 = vi.fn(async () => jsonResponse({ data: { id: 1, title: 'later' } }));
		const reloaded = buildClient(fetchMock2, {
			storage,
			networkMonitor: staticNetworkMonitor(true),
		});

		await expect(reloaded.waitFor('recover-1')).resolves.toEqual({ id: 1, title: 'later' });
		expect(fetchMock2).toHaveBeenCalledTimes(1);
	});

	it('refreshes the auth token on 401 and replays with the new bearer token', async () => {
		const fetchMock = vi.fn(async (url, init) => {
			const auth = (init.headers as Record<string, string>)['Authorization'];
			const endpoint = String(url);

			if (endpoint.endsWith('/auth/refresh')) {
				return jsonResponse({
					data: {
						access_token: 'new-token',
						refresh_token: 'new-refresh',
						expires: 3600,
						expires_at: Date.now() + 3600_000,
					},
				});
			}
			if (auth === 'Bearer new-token') return jsonResponse({ data: { id: 1 } });

			return jsonResponse(
				{ errors: [{ message: 'expired', extensions: { code: 'TOKEN_EXPIRED' } }] },
				{ status: 401 },
			);
		});

		const client = buildClient(fetchMock);

		// seed an already-expired access token
		await client.setToken('old-token');

		const promise = client.requestQueued(
			() => ({ path: '/items/a/1', method: 'PATCH', body: '{}' }),
			{ idempotencyKey: 'auth-1' },
		);

		await expect(promise).resolves.toEqual({ id: 1 });

		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls).toContain('https://example.com/auth/refresh');
		expect(urls.filter((url) => url.endsWith('/items/a/1'))).toHaveLength(2);

		const [initialAttempt, replayAttempt] = fetchMock.mock.calls.filter(([url]) =>
			String(url).endsWith('/items/a/1'),
		);

		expect((initialAttempt![1].headers as Record<string, string>)['Authorization']).toBe('Bearer old-token');
		expect((replayAttempt![1].headers as Record<string, string>)['Authorization']).toBe('Bearer new-token');
	});

	it('never persists the bearer token across restart', async () => {
		const storage = memoryQueueStorage();
		const monitor = staticNetworkMonitor(false);
		const fetchMock = vi.fn(async () => jsonResponse({ data: null }));

		const client = buildClient(fetchMock, { storage, networkMonitor: monitor, flushOnReconnect: false });
		await client.setToken('secret');

		client
			.requestQueued(
				() => ({ path: '/items/a', method: 'PATCH', body: '{}' }),
				{ idempotencyKey: 'no-token' },
			)
			.catch(() => {
				/* destroyed in afterEach while still queued */
			});

		await tick(5);
		const persisted = await storage.get();
		expect(JSON.stringify(persisted)).not.toContain('secret');
		expect(persisted[0]?.headers?.['Authorization']).toBeUndefined();
	});
});
