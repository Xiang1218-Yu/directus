import { ForbiddenError } from '@directus/errors';
import { SchemaBuilder } from '@directus/schema-builder';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDebugRegistry, rememberDebugInput, rememberDebugOutput } from '../flows/debug-registry.js';
import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
import { createMockKnex, resetKnexMocks } from '../test-utils/knex.js';
import { FlowSessionsService } from './flow-sessions.js';
import { ItemsService } from './items.js';

const { useEnvMock } = vi.hoisted(() => ({
	useEnvMock: vi.fn(() => ({}) as Record<string, unknown>),
}));

vi.mock('@directus/env', () => ({
	useEnv: useEnvMock,
}));

const mockRunDebugFlow = vi.fn();

vi.mock('../flows.js', () => ({
	getFlowManager: vi.fn(() => ({
		runDebugFlow: mockRunDebugFlow,
	})),
}));

vi.mock('../bus/index.js', () => ({
	useBus: vi.fn(() => ({
		publish: vi.fn(),
		subscribe: vi.fn(),
	})),
}));

vi.mock('../permissions/modules/validate-access/validate-access.js', () => ({
	validateAccess: vi.fn(),
}));

vi.mock('../utils/schedule.js', () => ({
	scheduleSynchronizedJob: vi.fn(),
}));

vi.mock('../database/index.js', async () => {
	const { mockDatabase } = await import('../test-utils/database.js');
	return mockDatabase();
});

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const FLOW_ID = '11111111-1111-4111-8111-111111111111';
const OP_A = '44444444-4444-4444-8444-444444444444';
const OP_B = '66666666-6666-4666-8666-666666666666';
const OP_NEVER = '55555555-5555-4555-8555-555555555555';

const flowRow = {
	id: FLOW_ID,
	name: 'Flow',
	status: 'active',
	trigger: 'manual',
	options: {},
	accountability: null,
	operation: null,
	operations: [],
};

const schema = new SchemaBuilder()
	.collection('directus_flows', (c) => {
		c.field('id').uuid().primary();
	})
	.collection('directus_flow_sessions', (c) => {
		c.field('id').uuid().primary();
		c.field('flow').uuid();
		c.field('name').string();
		c.field('status').string();
		c.field('input').text();
		c.field('steps').text();
		c.field('error').text();
		c.field('attempts').integer();
		c.field('started_operation').uuid();
		c.field('started_at').timestamp();
		c.field('heartbeat').timestamp();
		c.field('completed_at').timestamp();
		c.field('user_created').uuid();
	})
	.build();

const adminAccountability = {
	user: 'admin-user',
	role: 'admin-role',
	roles: [],
	admin: true,
	app: true,
} as any;

const ownerAccountability = {
	user: 'owner-user',
	role: 'some-role',
	roles: ['some-role'],
	admin: false,
	app: true,
} as any;

const otherAccountability = {
	user: 'other-user',
	role: 'some-role',
	roles: ['some-role'],
	admin: false,
	app: true,
} as any;

function sessionRow(overrides: Record<string, any> = {}): Record<string, any> {
	return {
		id: SESSION_ID,
		flow: FLOW_ID,
		name: null,
		status: 'succeeded',
		input: JSON.stringify({ hello: 'world' }),
		steps: JSON.stringify([
			{
				operation: OP_A,
				key: 'a',
				status: 'resolve',
				options: {},
				data: { token: '--redacted--' },
			},
			{
				operation: OP_B,
				key: 'b',
				status: 'reject',
				options: {},
				data: { message: 'boom' },
			},
		]),
		error: null,
		attempts: 1,
		started_operation: OP_A,
		started_at: new Date().toISOString(),
		heartbeat: new Date().toISOString(),
		completed_at: null,
		date_created: new Date().toISOString(),
		user_created: 'owner-user',
		...overrides,
	};
}

describe('FlowSessionsService', () => {
	const { db, tracker, mockSchemaBuilder } = createMockKnex();

	beforeEach(() => {
		resetKnexMocks(tracker, mockSchemaBuilder);
		vi.clearAllMocks();
		clearDebugRegistry();
		vi.spyOn(ItemsService.prototype, 'readOne').mockResolvedValue(flowRow);

		mockRunDebugFlow.mockResolvedValue({
			steps: [],
			lastOperationStatus: 'resolve',
			lastData: null,
			cancelled: false,
		});
	});

	describe('permissions', () => {
		it('validates flow read access for non-admins when loading the flow', async () => {
			const createOneSpy = vi.spyOn(FlowSessionsService.prototype, 'createOne').mockResolvedValue(SESSION_ID);

			const launchSpy = vi.spyOn(FlowSessionsService.prototype as any, 'launch').mockResolvedValue(undefined);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.startSession(FLOW_ID, { body: {} });

			expect(validateAccess).toHaveBeenCalledWith(
				expect.objectContaining({
					collection: 'directus_flows',
					action: 'read',
					accountability: ownerAccountability,
				}),
				expect.anything(),
			);

			createOneSpy.mockRestore();
			launchSpy.mockRestore();
		});

		it('forbids non-owners from cancelling a session they did not create', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'running' })]);

			const service = new FlowSessionsService({ knex: db, schema, accountability: otherAccountability });

			await expect(service.cancel(SESSION_ID)).rejects.toBeInstanceOf(ForbiddenError);
			expect(tracker.history.update?.length ?? 0).toBe(0);
		});

		it('allows the owner to cancel their own session', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'running' })]);
			tracker.on.update('directus_flow_sessions').response(1);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.cancel(SESSION_ID);

			expect(tracker.history.update).toHaveLength(1);
		});

		it('allows admins to act on sessions created by other users', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'running' })]);
			tracker.on.update('directus_flow_sessions').response(1);

			const service = new FlowSessionsService({ knex: db, schema, accountability: adminAccountability });
			await service.cancel(SESSION_ID);

			expect(tracker.history.update).toHaveLength(1);
		});

		it('only selects sessions owned by the requester for non-admins', async () => {
			tracker.on.select('directus_flow_sessions').response([]);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.readFlowSessions(FLOW_ID);

			const selectSql = tracker.history.select?.find((call) =>
				String(call.sql).toLowerCase().includes('directus_flow_sessions'),
			);

			expect(JSON.stringify(selectSql?.bindings ?? '')).toContain('owner-user');
		});
	});

	describe('cancellation', () => {
		it('is idempotent and does not cancel a terminal session', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'succeeded' })]);
			tracker.on.update('directus_flow_sessions').response(0);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.cancel(SESSION_ID);
			await service.cancel(SESSION_ID);

			for (const call of tracker.history.update ?? []) {
				expect(call.bindings).toContain('cancelling');
			}
		});
	});

	describe('rerun semantics', () => {
		it('only transitions a terminal session back to running', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'running' })]);
			tracker.on.update('directus_flow_sessions').response(0);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });

			await expect(service.rerun(SESSION_ID, null, {})).rejects.toThrow(/already running/);
			expect(mockRunDebugFlow).not.toHaveBeenCalled();
		});

		it('rejects reruns from an operation that was never executed', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow()]);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });

			await expect(service.rerun(SESSION_ID, OP_NEVER, {})).rejects.toThrow(/has not been executed/);
		});

		it('requires the original test input when process memory was lost', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'failed' })]);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });

			// Nothing registered in the debug registry (simulates restart / other instance)
			await expect(service.rerun(SESSION_ID, null)).rejects.toThrow(/original test input/);
			expect(tracker.history.update?.length ?? 0).toBe(0);
		});

		it('seeds the resumed run with ORIGINAL upstream results, not redacted copies', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'failed' })]);
			tracker.on.update('directus_flow_sessions').response(1);

			rememberDebugInput(SESSION_ID, { hello: 'world' });
			rememberDebugOutput(SESSION_ID, 'a', { token: 'PLAINTEXT_UPSTREAM_SECRET' });
			rememberDebugOutput(SESSION_ID, 'b', { message: 'boom' });

			const launchSpy = vi.spyOn(FlowSessionsService.prototype as any, 'launch');
			launchSpy.mockResolvedValue(undefined);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.rerun(SESSION_ID, OP_B);

			expect(launchSpy).toHaveBeenCalledTimes(1);

			const call = launchSpy.mock.calls[0]![2] as any;
			expect(call.attempt).toBe(2);
			expect(call.startAtOperation).toBe(OP_B);
			// Rerun node is NOT seeded (it gets executed), upstream original output IS
			expect(call.seedData.a).toEqual({ token: 'PLAINTEXT_UPSTREAM_SECRET' });
			expect(call.seedData.b).toBeUndefined();
			// $last must be the ORIGINAL output of the node directly before the rerun point (a)
			expect(call.seedData['$last']).toEqual({ token: 'PLAINTEXT_UPSTREAM_SECRET' });
			expect(call.seedData['$trigger']).toEqual({ hello: 'world' });
			expect(call.input).toEqual({ hello: 'world' });
		});

		it('uses fresh original input when provided and persists only its redacted copy', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'failed' })]);
			tracker.on.update('directus_flow_sessions').response(1);

			const launchSpy = vi.spyOn(FlowSessionsService.prototype as any, 'launch');
			launchSpy.mockResolvedValue(undefined);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });

			await service.rerun(SESSION_ID, null, {
				headers: { authorization: 'Bearer new-secret' },
				ok: true,
			});

			const call = launchSpy.mock.calls[0]![2] as any;
			expect(call.input).toEqual({ headers: { authorization: 'Bearer new-secret' }, ok: true });

			const updateBindings = JSON.stringify(tracker.history.update![0]!.bindings);
			expect(updateBindings).not.toContain('new-secret');
			expect(updateBindings).toContain('ok');
		});

		it('increments the attempt so an old runner cannot write the terminal state', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'failed', attempts: 2 })]);
			tracker.on.update('directus_flow_sessions').response(1);
			rememberDebugInput(SESSION_ID, {});

			const launchSpy = vi.spyOn(FlowSessionsService.prototype as any, 'launch');
			launchSpy.mockResolvedValue(undefined);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.rerun(SESSION_ID, null);

			expect((launchSpy.mock.calls[0]![2] as any).attempt).toBe(3);
		});
	});

	describe('redaction boundary', () => {
		it('runs with the ORIGINAL input but persists only the redacted copy', async () => {
			const insertedPayloads: any[] = [];

			vi.spyOn(FlowSessionsService.prototype, 'createOne').mockImplementation(async (data) => {
				insertedPayloads.push(data);
				return '33333333-3333-4333-8333-333333333333';
			});

			const launchSpy = vi.spyOn(FlowSessionsService.prototype as any, 'launch');
			launchSpy.mockResolvedValue(undefined);

			const service = new FlowSessionsService({ knex: db, schema, accountability: adminAccountability });

			const originalInput = {
				headers: { authorization: 'Bearer secret' },
				payload: { password: 'hunter2', name: 'ok' },
			};

			await service.startSession(FLOW_ID, originalInput);

			const persistedInput = JSON.parse(insertedPayloads[0]!.input);
			expect(persistedInput.headers.authorization).not.toContain('secret');
			expect(persistedInput.payload.password).not.toContain('hunter2');
			expect(persistedInput.payload.name).toBe('ok');

			// Executor receives the original, unredacted input
			expect((launchSpy.mock.calls[0]![2] as any).input).toBe(originalInput);
		});
	});

	describe('restart and multi-instance recovery', () => {
		it('reapStaleSessions cancels non-terminal sessions on boot in single-instance mode', async () => {
			vi.mocked(useEnvMock).mockReturnValue({ REDIS_ENABLED: false } as any);
			tracker.on.update('directus_flow_sessions').response(2);

			await FlowSessionsService.reapStaleSessions(db);

			const update = tracker.history.update!.at(-1)!;
			expect(update.bindings).toContain('cancelled');
			expect(JSON.stringify(update.bindings)).toContain('running');
			expect(JSON.stringify(update.bindings)).toContain('cancelling');
		});

		it('reapStaleSessions is a no-op with Redis (another instance may own the run)', async () => {
			vi.mocked(useEnvMock).mockReturnValue({ REDIS_ENABLED: true } as any);
			const updatesBefore = tracker.history.update?.length ?? 0;

			await FlowSessionsService.reapStaleSessions(db);

			expect(tracker.history.update?.length ?? 0).toBe(updatesBefore);
		});

		it('registers the cluster-wide heartbeat sweep through the synchronized scheduler', async () => {
			const { scheduleSynchronizedJob: schedule } = await import('../utils/schedule.js');

			FlowSessionsService.scheduleStaleSessionReaping();

			expect(schedule).toHaveBeenCalledWith('flow-sessions-reaper', '*/2 * * * *', expect.any(Function));
		});
	});
});
