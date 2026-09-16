import { ForbiddenError } from '@directus/errors';
import { SchemaBuilder } from '@directus/schema-builder';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
import { createMockKnex, resetKnexMocks } from '../test-utils/knex.js';
import { FlowSessionsService } from './flow-sessions.js';
import { ItemsService } from './items.js';

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

vi.mock('../database/index.js', async () => {
	const { mockDatabase } = await import('../test-utils/database.js');
	return mockDatabase();
});

const flowRow = {
	id: '11111111-1111-4111-8111-111111111111',
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
		id: '22222222-2222-4222-8222-222222222222',
		flow: '11111111-1111-4111-8111-111111111111',
		name: null,
		status: 'succeeded',
		input: JSON.stringify({ hello: 'world' }),
		steps: JSON.stringify([
			{
				operation: '44444444-4444-4444-8444-444444444444',
				key: 'a',
				status: 'reject',
				options: {},
				data: { message: 'boom' },
			},
		]),
		error: null,
		attempts: 1,
		started_operation: '44444444-4444-4444-8444-444444444444',
		started_at: new Date().toISOString(),
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
			const createOneSpy = vi
				.spyOn(FlowSessionsService.prototype, 'createOne')
				.mockResolvedValue('22222222-2222-4222-8222-222222222222');

			const launchSpy = vi.spyOn(FlowSessionsService.prototype as any, 'launch').mockResolvedValue(undefined);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.startSession('11111111-1111-4111-8111-111111111111', { body: {} });

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

			await expect(service.cancel('22222222-2222-4222-8222-222222222222')).rejects.toBeInstanceOf(ForbiddenError);
			expect(tracker.history.update?.length ?? 0).toBe(0);
		});

		it('allows the owner to cancel their own session', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'running' })]);
			tracker.on.update('directus_flow_sessions').response(1);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.cancel('22222222-2222-4222-8222-222222222222');

			expect(tracker.history.update).toHaveLength(1);
			expect(tracker.history.update![0]!.method).toBe('update');
		});

		it('allows admins to act on sessions created by other users', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'running' })]);
			tracker.on.update('directus_flow_sessions').response(1);

			const service = new FlowSessionsService({ knex: db, schema, accountability: adminAccountability });
			await service.cancel('22222222-2222-4222-8222-222222222222');

			expect(tracker.history.update).toHaveLength(1);
		});
	});

	describe('cancellation', () => {
		it('is idempotent and does not cancel a terminal session', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'succeeded' })]);
			tracker.on.update('directus_flow_sessions').response(0);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.cancel('22222222-2222-4222-8222-222222222222');
			await service.cancel('22222222-2222-4222-8222-222222222222');

			const updateCalls = tracker.history.update ?? [];

			for (const call of updateCalls) {
				expect(call.bindings).toContain('cancelling');
			}
		});
	});

	describe('rerun semantics', () => {
		it('only transitions a terminal session back to running', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'running' })]);
			tracker.on.update('directus_flow_sessions').response(0);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });

			await expect(service.rerun('22222222-2222-4222-8222-222222222222', null)).rejects.toThrow(/already running/);
			expect(mockRunDebugFlow).not.toHaveBeenCalled();
		});

		it('rejects reruns from an operation that was never executed', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow()]);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });

			await expect(
				service.rerun('22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555'),
			).rejects.toThrow(/has not been executed/);
		});

		it('seeds the resumed run with the captured output of previous steps', async () => {
			tracker.on.select('directus_flow_sessions').response([sessionRow({ status: 'failed' })]);
			tracker.on.update('directus_flow_sessions').response(1);

			const launchSpy = vi.spyOn(FlowSessionsService.prototype as any, 'launch').mockResolvedValue(undefined);

			const service = new FlowSessionsService({ knex: db, schema, accountability: ownerAccountability });
			await service.rerun('22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444');

			expect(launchSpy).toHaveBeenCalledTimes(1);
			const options = launchSpy.mock.calls[0]![3];
			expect(options.startAtOperation).toBe('44444444-4444-4444-8444-444444444444');
			expect(options.seedData).toMatchObject({ a: { message: 'boom' } });
			expect(options.seedData['$trigger']).toEqual({ hello: 'world' });
			expect(mockRunDebugFlow).not.toHaveBeenCalled();
		});
	});

	describe('redaction', () => {
		it('redacts sensitive keys in the test input before persisting the session', async () => {
			const insertedPayloads: any[] = [];

			vi.spyOn(FlowSessionsService.prototype, 'createOne').mockImplementation(async (data) => {
				insertedPayloads.push(data);
				return '33333333-3333-4333-8333-333333333333';
			});

			vi.spyOn(FlowSessionsService.prototype as any, 'launch').mockResolvedValue(undefined);

			const service = new FlowSessionsService({ knex: db, schema, accountability: adminAccountability });

			await service.startSession('11111111-1111-4111-8111-111111111111', {
				headers: { authorization: 'Bearer secret' },
				payload: { password: 'hunter2', name: 'ok' },
			});

			const persistedInput = JSON.parse(insertedPayloads[0]!.input);
			expect(persistedInput.headers.authorization).not.toContain('secret');
			expect(persistedInput.payload.password).not.toContain('hunter2');
			expect(persistedInput.payload.name).toBe('ok');
		});
	});
});
