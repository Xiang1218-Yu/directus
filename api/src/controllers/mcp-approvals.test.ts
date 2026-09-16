import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createMockRequest, createMockResponse, getRouteHandler } from '../test-utils/controllers.js';

const listForReview = vi.fn();
const getForReview = vi.fn();
const review = vi.fn();

vi.mock('../services/mcp-approvals/index.js', () => ({
	McpApprovalsService: vi.fn().mockImplementation(() => ({
		listForReview,
		getForReview,
		review,
	})),
}));

const executeApproved = vi.fn().mockResolvedValue({ ok: true, result: { type: 'text', data: { id: 'x' } } });

vi.mock('../ai/tools/index.js', () => ({
	ALL_TOOLS: [],
	ToolRegistry: vi.fn().mockImplementation(() => ({
		mount: vi.fn(() => ({ executeApproved })),
	})),
}));

vi.mock('../services/settings.js', () => ({
	SettingsService: vi.fn().mockImplementation(() => ({
		readSingleton: vi.fn().mockResolvedValue({ mcp_allow_deletes: false }),
	})),
}));

vi.mock('../middleware/respond.js', () => ({
	// Mirror the real middleware: serialize res.locals.payload so tests can assert on it.
	respond: vi.fn((_req, res) => {
		res.json(res.locals['payload']);
	}),
}));

const { default: router } = await import('./mcp-approvals.js');

function accountability(overrides: Record<string, unknown> = {}) {
	return {
		user: 'reviewer-1',
		role: null,
		roles: [],
		admin: false,
		app: true,
		ip: null,
		...overrides,
	};
}

/** Run an express route's full middleware stack with shared req/res and a chained next. */
async function runStack(method: string, path: string, req: ReturnType<typeof createMockRequest>) {
	const res = createMockResponse();
	const stack = getRouteHandler(router, method, path);

	let index = 0;

	const next = vi.fn(async (error?: unknown) => {
		if (error) throw error;

		const layer = stack[index++];
		if (!layer) return;

		await layer.handle(req, res, next);
	});

	await next();

	return res;
}

describe('mcp-approvals controller', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		executeApproved.mockResolvedValue({ ok: true, result: { type: 'text', data: { id: 'x' } } });
	});

	test('rejects unauthenticated requests', async () => {
		const req = createMockRequest({ accountability: undefined as never });
		const res = createMockResponse();

		// The auth check is registered via router.use, so test it directly from the stack.
		const authLayer = (
			router as unknown as {
				stack: Array<{ handle: (req: unknown, res: unknown, next: (err?: unknown) => void) => void }>;
			}
		).stack.find((layer) => layer.handle.length === 3 && !(layer as unknown as { route?: unknown }).route);

		expect(authLayer).toBeTruthy();

		let nextError: unknown;

		const next = vi.fn((error?: unknown) => {
			nextError = error;
		});

		await authLayer!.handle(req, res, next);

		expect(nextError).toEqual(expect.objectContaining({ message: expect.stringContaining('Authentication') }));
	});

	test('GET / returns the reviewer queue', async () => {
		listForReview.mockResolvedValue([{ id: 'a', status: 'pending' }]);

		const req = createMockRequest({ accountability: accountability() });
		const res = await runStack('GET', '/', req);

		expect(listForReview).toHaveBeenCalledWith({ status: null });
		expect(res.locals['payload']).toEqual({ data: [{ id: 'a', status: 'pending' }] });
	});

	test('GET /?status=pending passes the filter', async () => {
		listForReview.mockResolvedValue([]);

		const req = createMockRequest({
			accountability: accountability(),
			query: { status: 'pending' },
		});

		await runStack('GET', '/', req);

		expect(listForReview).toHaveBeenCalledWith({ status: 'pending' });
	});

	test('POST /:id/approve executes through the service with the original request', async () => {
		review.mockImplementation(
			async (
				_id: string,
				_decision: string,
				options: {
					execute: (params: {
						name: string;
						args: Record<string, unknown>;
						accountability: Record<string, unknown>;
						schema: Record<string, unknown>;
					}) => Promise<void>;
				},
			) => {
				await options.execute({
					name: 'items',
					args: { collection: 'articles', action: 'create' },
					accountability: accountability({ user: 'requester-1' }),
					schema: {},
				});

				return { id: 'a', status: 'completed' };
			},
		);

		const req = createMockRequest({
			accountability: accountability({ admin: true }),
			params: { id: 'a' },
			body: {},
		});

		const res = await runStack('POST', '/:id/approve', req);

		expect(executeApproved).toHaveBeenCalledTimes(1);
		expect(executeApproved).toHaveBeenCalledWith('items', expect.objectContaining({ action: 'create' }));
		expect(res.locals['payload']).toMatchObject({ data: { status: 'completed' } });
	});

	test('reject never calls the executor', async () => {
		review.mockResolvedValue({ id: 'a', status: 'rejected' });

		const req = createMockRequest({
			accountability: accountability({ admin: true }),
			params: { id: 'a' },
			body: { note: 'no' },
		});

		await runStack('POST', '/:id/reject', req);

		expect(executeApproved).not.toHaveBeenCalled();
		expect(review).toHaveBeenCalledWith('a', 'reject', expect.objectContaining({ note: 'no' }));
	});
});
