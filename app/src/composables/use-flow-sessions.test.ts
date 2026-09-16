import type { FlowSessionRaw } from '@directus/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { effectScope, ref, type Ref } from 'vue';
import { useFlowSessions } from './use-flow-sessions';

const apiMocks = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	patch: vi.fn(),
	delete: vi.fn(),
}));

vi.mock('@/api', () => ({
	default: apiMocks,
}));

vi.mock('@/utils/get-root-path', () => ({
	getRootPath: () => '/',
}));

vi.mock('@/utils/unexpected-error', () => ({
	unexpectedError: vi.fn(),
}));

const realtimeMocks = vi.hoisted(() => {
	const handlers: Record<string, Set<(message: any) => void>> = {};

	return {
		connect: vi.fn(async () => undefined),
		sendMessage: vi.fn(async () => undefined),
		onWebSocket: vi.fn((event: string, handler: (message: any) => void) => {
			(handlers[event] ??= new Set()).add(handler);
			return () => handlers[event]!.delete(handler);
		}),
		resetHandlers: () => {
			for (const key of Object.keys(handlers)) handlers[key]!.clear();
		},
		emit: (event: string, message: unknown) => {
			for (const handler of handlers[event] ?? []) handler(message);
		},
	};
});

vi.mock('@directus/sdk', () => ({
	realtime: () => () => ({}),
}));

vi.mock('@/sdk', () => ({
	sdk: {
		url: new URL('http://localhost'),
		with: () => realtimeMocks,
	},
}));

const flowId: Ref<string> = ref('11111111-1111-4111-8111-111111111111');

function session(overrides: Partial<FlowSessionRaw>): FlowSessionRaw {
	return {
		id: '22222222-2222-4222-8222-222222222222',
		flow: flowId.value,
		name: null,
		status: 'running',
		input: null,
		steps: [],
		error: null,
		attempts: 1,
		started_operation: null,
		started_at: new Date().toISOString(),
		heartbeat: null,
		completed_at: null,
		date_created: new Date().toISOString(),
		user_created: 'user-1',
		...overrides,
	};
}

let scope: ReturnType<typeof effectScope>;
let composable: ReturnType<typeof useFlowSessions>;

function setupComposable() {
	scope = effectScope();
	composable = scope.run(() => useFlowSessions(flowId))!;
}

beforeEach(() => {
	vi.clearAllMocks();
	realtimeMocks.resetHandlers();
});

afterEach(() => {
	scope?.stop();
});

describe('useFlowSessions', () => {
	test('starts empty and loads sessions with refresh', async () => {
		apiMocks.get.mockResolvedValue({ data: { data: [] } });
		setupComposable();

		expect(composable.sessions.value).toEqual([]);

		await composable.refresh();
		expect(apiMocks.get).toHaveBeenCalledWith(`/flows/${flowId.value}/sessions`);
		expect(composable.sessions.value).toEqual([]);
	});

	test('creates a session and prepends it to the list', async () => {
		apiMocks.get.mockResolvedValue({ data: { data: [] } });
		const created = session({ id: '33333333-3333-4333-8333-333333333333' });
		apiMocks.post.mockResolvedValue({ data: { data: created } });

		setupComposable();
		await composable.createSession({ body: {} }, 'first try');

		expect(apiMocks.post).toHaveBeenCalledWith(`/flows/${flowId.value}/sessions`, {
			input: { body: {} },
			name: 'first try',
		});

		expect(composable.sessions.value[0]!.id).toBe(created.id);
	});

	test('cancel updates the session to cancelling state', async () => {
		const running = session({});
		apiMocks.get.mockResolvedValue({ data: { data: [running] } });
		apiMocks.post.mockResolvedValue({ data: { data: { ...running, status: 'cancelling' } } });

		setupComposable();
		await composable.refresh();
		await composable.cancel(running.id);

		expect(apiMocks.post).toHaveBeenCalledWith(`/flows/sessions/${running.id}/cancel`);
		expect(composable.sessions.value[0]!.status).toBe('cancelling');
	});

	test('rerun posts the failing operation id', async () => {
		const failed = session({ status: 'failed' });
		apiMocks.get.mockResolvedValue({ data: { data: [failed] } });
		apiMocks.post.mockResolvedValue({ data: { data: session({ status: 'running', attempts: 2 }) } });

		setupComposable();
		await composable.refresh();
		await composable.rerun(failed.id, '44444444-4444-4444-8444-444444444444');

		expect(apiMocks.post).toHaveBeenCalledWith(`/flows/sessions/${failed.id}/rerun`, {
			operation: '44444444-4444-4444-8444-444444444444',
		});
	});

	test('remove drops the session from the local state', async () => {
		apiMocks.get.mockResolvedValue({ data: { data: [session({})] } });
		apiMocks.delete.mockResolvedValue({});

		setupComposable();
		await composable.refresh();
		await composable.remove(session({}).id);

		expect(composable.sessions.value).toEqual([]);
	});

	test('marks terminal sessions but not running ones as runningSessions', async () => {
		apiMocks.get.mockResolvedValue({
			data: {
				data: [
					session({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'running' }),
					session({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'cancelling' }),
					session({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'failed' }),
					session({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'succeeded' }),
				],
			},
		});

		setupComposable();
		await composable.refresh();

		expect(composable.runningSessions.value.map((s) => s.id).sort()).toEqual([
			'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
		]);
	});

	test('live subscription applies step progress and removes deleted sessions', async () => {
		const running = session({});
		apiMocks.get.mockResolvedValue({ data: { data: [running] } });

		setupComposable();
		await composable.refresh();
		await composable.connectLive();

		expect(realtimeMocks.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'subscribe', collection: 'directus_flow_sessions' }),
		);

		realtimeMocks.emit('message', {
			type: 'subscription',
			event: 'update',
			uid: `flow-sessions-${flowId.value}`,
			data: [
				session({
					status: 'failed',
					steps: [
						{
							operation: 'op-1',
							key: 'one',
							status: 'reject',
							options: {},
							data: { message: 'boom' },
						},
					],
				}),
			],
		});

		expect(composable.sessions.value[0]!.status).toBe('failed');
		expect(composable.sessions.value[0]!.steps).toHaveLength(1);

		realtimeMocks.emit('message', {
			type: 'subscription',
			event: 'delete',
			uid: `flow-sessions-${flowId.value}`,
			data: [running.id],
		});

		expect(composable.sessions.value).toEqual([]);
	});

	test('ignores subscription messages for other flows or other subscriptions', async () => {
		apiMocks.get.mockResolvedValue({ data: { data: [] } });

		setupComposable();
		await composable.refresh();

		realtimeMocks.emit('message', {
			type: 'subscription',
			event: 'create',
			uid: 'some-other-uid',
			data: [session({ flow: '99999999-9999-4999-8999-999999999999' })],
		});

		expect(composable.sessions.value).toEqual([]);
	});
});
