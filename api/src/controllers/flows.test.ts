import { ForbiddenError } from '@directus/errors';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createMockRequest, createMockResponse, getRouteHandler } from '../test-utils/controllers.js';

const serviceMocks = vi.hoisted(() => ({
	startSession: vi.fn(),
	readFlowSessions: vi.fn(),
	readSession: vi.fn(),
	rerun: vi.fn(),
	cancel: vi.fn(),
	markStatus: vi.fn(),
	deleteOne: vi.fn(),
	isLocked: vi.fn(),
}));

vi.mock('../services/flow-sessions.js', () => ({
	FlowSessionsService: vi.fn(() => ({
		startSession: serviceMocks.startSession,
		readFlowSessions: serviceMocks.readFlowSessions,
		readSession: serviceMocks.readSession,
		rerun: serviceMocks.rerun,
		cancel: serviceMocks.cancel,
		markStatus: serviceMocks.markStatus,
		deleteOne: serviceMocks.deleteOne,
		knex: vi.fn(),
	})),
	hydrateSessionRow: vi.fn((row) => row),
}));

vi.mock('../services/flows.js', () => ({
	FlowsService: vi.fn(() => ({})),
}));

vi.mock('../services/meta.js', () => ({
	MetaService: vi.fn(() => ({})),
}));

vi.mock('../license/manager.js', () => ({
	getLicenseManager: vi.fn(() => ({ isLocked: serviceMocks.isLocked })),
}));

vi.mock('../middleware/respond.js', () => ({
	respond: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/use-collection.js', () => ({
	default: () => (req: any, _res: unknown, next: () => void) => {
		req.collection = 'directus_flows';
		next();
	},
}));

vi.mock('../middleware/validate-batch.js', () => ({
	validateBatch: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../utils/sanitize-query.js', () => ({
	sanitizeQuery: vi.fn(async (query: unknown) => query),
}));

vi.mock('../flows.js', () => ({
	getFlowManager: vi.fn(() => ({ runWebhookFlow: vi.fn() })),
}));

const { default: router } = await import('./flows.js');

const UUID_REGEX = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Find a debug session route via its method + parameterized path pattern. */
function findHandler(method: string, pattern: string) {
	const path = pattern.replace(/:pk\b/g, `:pk(${UUID_REGEX})`).replace(/:session\b/g, `:session(${UUID_REGEX})`);

	const layers = getRouteHandler(router, method, path);
	return layers;
}

const adminAccountability = { user: 'admin', role: 'r', roles: [], admin: true, app: true } as any;

const ownerAccountability = { user: 'owner', role: 'r', roles: ['r'], admin: false, app: true } as any;

async function invokeStack(method: string, path: string, reqOverrides: Record<string, any> = {}) {
	const layers = findHandler(method, path);
	const req = createMockRequest({ accountability: adminAccountability, ...reqOverrides });
	const res = createMockResponse();
	const next = vi.fn();

	for (const layer of layers) {
		await new Promise<void>((resolve, reject) => {
			const maybe = layer.handle(req, res, (error?: unknown) => {
				if (error) reject(error);
				else resolve();
			});

			if (maybe instanceof Promise) {
				maybe.then(() => resolve()).catch(reject);
			}
		});
	}

	return { req, res, next };
}

beforeEach(() => {
	vi.clearAllMocks();
	serviceMocks.isLocked.mockResolvedValue(false);
	serviceMocks.startSession.mockResolvedValue('22222222-2222-4222-8222-222222222222');
	serviceMocks.readFlowSessions.mockResolvedValue([]);
	serviceMocks.readSession.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' });
});

describe('flows debug session routes', () => {
	test('POST /:pk/sessions starts a session with the test input and name', async () => {
		await invokeStack('POST', '/:pk/sessions', {
			params: { pk: '11111111-1111-4111-8111-111111111111' },
			body: { input: { hello: 'world' }, name: 'debug run' },
		});

		expect(serviceMocks.startSession).toHaveBeenCalledWith(
			'11111111-1111-4111-8111-111111111111',
			{ hello: 'world' },
			'debug run',
		);
	});

	test('POST /:pk/sessions rejects non-object bodies before touching the service', async () => {
		await expect(
			invokeStack('POST', '/:pk/sessions', {
				params: { pk: '11111111-1111-4111-8111-111111111111' },
				body: ['not-an-object'],
			}),
		).rejects.toThrow();

		expect(serviceMocks.startSession).not.toHaveBeenCalled();
	});

	test('GET /:pk/sessions lists sessions for the flow', async () => {
		await invokeStack('GET', '/:pk/sessions', {
			params: { pk: '11111111-1111-4111-8111-111111111111' },
		});

		expect(serviceMocks.readFlowSessions).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
	});

	test('POST /sessions/:session/rerun forwards the operation and input', async () => {
		await invokeStack('POST', '/sessions/:session/rerun', {
			params: { session: '22222222-2222-4222-8222-222222222222' },
			body: { operation: null },
		});

		expect(serviceMocks.rerun).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', null, undefined);
	});

	test('POST /sessions/:session/rerun forwards a provided test input', async () => {
		await invokeStack('POST', '/sessions/:session/rerun', {
			params: { session: '22222222-2222-4222-8222-222222222222' },
			body: { operation: '44444444-4444-4444-8444-444444444444', input: { a: 1 } },
		});

		expect(serviceMocks.rerun).toHaveBeenCalledWith(
			'22222222-2222-4222-8222-222222222222',
			'44444444-4444-4444-8444-444444444444',
			{ a: 1 },
		);
	});

	test('POST /sessions/:session/cancel cancels the session', async () => {
		await invokeStack('POST', '/sessions/:session/cancel', {
			params: { session: '22222222-2222-4222-8222-222222222222' },
			body: {},
		});

		expect(serviceMocks.cancel).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
	});

	test('PATCH /sessions/:session marks the requested status', async () => {
		await invokeStack('PATCH', '/sessions/:session', {
			params: { session: '22222222-2222-4222-8222-222222222222' },
			body: { status: 'failed' },
		});

		expect(serviceMocks.markStatus).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', 'failed');
	});

	test('DELETE /sessions/:session deletes the session', async () => {
		await invokeStack('DELETE', '/sessions/:session', {
			params: { session: '22222222-2222-4222-8222-222222222222' },
		});

		expect(serviceMocks.deleteOne).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222');
	});

	test('permission errors from the service propagate as forbidden errors', async () => {
		serviceMocks.cancel.mockRejectedValueOnce(new ForbiddenError());

		await expect(
			invokeStack('POST', '/sessions/:session/cancel', {
				params: { session: '22222222-2222-4222-8222-222222222222' },
				body: {},
				accountability: ownerAccountability,
			}),
		).rejects.toBeInstanceOf(ForbiddenError);
	});

	test('starting and rerunning sessions are blocked when the flows license is locked', async () => {
		serviceMocks.isLocked.mockResolvedValue(true);

		await expect(
			invokeStack('POST', '/:pk/sessions', {
				params: { pk: '11111111-1111-4111-8111-111111111111' },
				body: { input: {} },
			}),
		).rejects.toThrow();

		await expect(
			invokeStack('POST', '/sessions/:session/rerun', {
				params: { session: '22222222-2222-4222-8222-222222222222' },
				body: {},
			}),
		).rejects.toThrow();

		expect(serviceMocks.startSession).not.toHaveBeenCalled();
		expect(serviceMocks.rerun).not.toHaveBeenCalled();
	});
});
