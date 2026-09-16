import type { Flow } from '@directus/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@directus/env', () => ({
	useEnv: vi.fn().mockReturnValue({
		EMAIL_TEMPLATES_PATH: './templates',
		STORAGE_LOCATIONS: ['local'],
		REDIS_ENABLED: false,
		EXTENSIONS_PATH: './extensions',
	}),
}));

vi.mock('./logger/index.js', () => ({
	useLogger: vi.fn().mockReturnValue({
		warn: vi.fn(),
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.mock('./bus/index.js', () => ({
	useBus: vi.fn().mockReturnValue({
		subscribe: vi.fn(),
		publish: vi.fn(),
	}),
}));

vi.mock('./database/index.js', () => ({
	default: vi.fn(),
}));

vi.mock('./utils/get-schema.js', () => ({
	getSchema: vi.fn().mockResolvedValue({}),
}));

vi.mock('./services/flows.js', () => ({
	FlowsService: vi.fn().mockImplementation(() => ({
		readByQuery: vi.fn().mockResolvedValue([]),
	})),
}));

vi.mock('./utils/schedule.js', () => ({
	scheduleSynchronizedJob: vi.fn(),
	validateCron: vi.fn().mockReturnValue(true),
}));

vi.mock('./emitter.js', () => ({
	default: {
		onAction: vi.fn(),
		onFilter: vi.fn(),
		offAction: vi.fn(),
		offFilter: vi.fn(),
	},
}));

vi.mock('./cache.js', () => ({
	getCache: vi.fn().mockReturnValue({ cache: null, systemCache: null, lockCache: null }),
	getCacheValue: vi.fn(),
	setCacheValue: vi.fn(),
	clearSystemCache: vi.fn(),
}));

vi.mock('./redis/utils/redis-config-available.js', () => ({
	redisConfigAvailable: vi.fn().mockReturnValue(false),
}));

vi.mock('./services/notifications.js', () => ({
	NotificationsService: vi.fn(),
}));

vi.mock('./permissions/cache.js', () => ({
	withCache: vi.fn((fn: any) => fn),
}));

vi.mock('./permissions/lib/fetch-permissions.js', () => ({
	fetchPermissions: vi.fn().mockResolvedValue([]),
}));

vi.mock('./permissions/lib/fetch-policies.js', () => ({
	fetchPolicies: vi.fn().mockResolvedValue([]),
}));

vi.mock('./services/activity.js', () => ({
	ActivityService: vi.fn(),
}));

vi.mock('./services/revisions.js', () => ({
	RevisionsService: vi.fn(),
}));

vi.mock('./services/index.js', () => ({}));

vi.mock('./utils/get-service.js', () => ({
	getService: vi.fn(),
}));

vi.mock('./utils/redact-object.js', () => ({
	redactObject: vi.fn((obj: any) => obj),
}));

vi.mock('./utils/construct-flow-tree.js', () => ({
	constructFlowTree: vi.fn((flow: Flow) => flow),
}));

const flowWithOperations = {
	id: 'debug-flow',
	name: 'Debug Flow',
	status: 'active',
	trigger: 'manual',
	options: { collections: ['articles'], requireSelection: false },
	accountability: null,
	operation: null,
	operations: [],
} as unknown as Flow;

function op(id: string, key: string, resolve: any = null, reject: any = null) {
	return {
		id,
		key,
		name: null,
		type: `mock-${id}`,
		position_x: 0,
		position_y: 0,
		options: {},
		resolve,
		reject,
	};
}

describe('FlowManager debug runs', () => {
	let getFlowManager: typeof import('./flows.js').getFlowManager;

	beforeEach(async () => {
		vi.resetModules();
		const module = await import('./flows.js');
		getFlowManager = module.getFlowManager;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	test('records every step with its output and resolves with the last data', async () => {
		const manager = getFlowManager();

		const b = op('op-b', 'b');
		const a = op('op-a', 'a', b);
		const flow = { ...flowWithOperations, operation: a } as unknown as Flow;

		manager.addOperation('mock-op-a', async () => 'result-a');
		manager.addOperation('mock-op-b', async () => 'result-b');

		const result = await manager.runDebugFlow(flow, { hello: 'world' });

		expect(result.cancelled).toBe(false);
		expect(result.lastOperationStatus).toBe('resolve');
		expect(result.lastData).toBe('result-b');
		expect(result.steps.map((step) => step.key)).toEqual(['a', 'b']);
		expect(result.steps.map((step) => step.data)).toEqual(['result-a', 'result-b']);
	});

	test('follows the reject branch and reports the last status as reject', async () => {
		const manager = getFlowManager();

		const errorOp = op('op-err', 'errorBranch');
		const a = op('op-a', 'a', null, errorOp);
		const flow = { ...flowWithOperations, operation: a } as unknown as Flow;

		manager.addOperation('mock-op-a', async () => {
			throw new Error('boom');
		});

		manager.addOperation('mock-op-err', async () => 'recovered');

		const result = await manager.runDebugFlow(flow, null);

		expect(result.lastOperationStatus).toBe('resolve');

		expect(result.steps.map((step) => [step.key, step.status])).toEqual([
			['a', 'reject'],
			['errorBranch', 'resolve'],
		]);

		expect((result.steps[0]!.data as Error).message).toBe('boom');
		expect(result.lastData).toBe('recovered');
	});

	test('stops the run between operations when shouldCancel returns true', async () => {
		const manager = getFlowManager();

		const b = op('op-b', 'b');
		const a = op('op-a', 'a', b);
		const flow = { ...flowWithOperations, operation: a } as unknown as Flow;

		manager.addOperation('mock-op-a', async () => 'result-a');
		manager.addOperation('mock-op-b', async () => 'result-b');

		let checked = 0;

		const result = await manager.runDebugFlow(
			flow,
			null,
			{},
			{
				shouldCancel: () => {
					checked += 1;
					return checked > 1;
				},
			},
		);

		expect(result.cancelled).toBe(true);
		expect(result.steps.map((step) => step.key)).toEqual(['a']);
	});

	test('resumes from a later operation using seed data', async () => {
		const manager = getFlowManager();

		const b = op('op-b', 'b');
		const a = op('op-a', 'a', b);
		const flow = { ...flowWithOperations, operation: a } as unknown as Flow;

		const receivedContexts: any[] = [];
		manager.addOperation('mock-op-a', async () => 'result-a');

		manager.addOperation('mock-op-b', async (_options, context) => {
			receivedContexts.push(context.data['a']);
			return 'result-b';
		});

		const result = await manager.runDebugFlow(
			flow,
			{ hello: 'world' },
			{},
			{
				startAtOperation: 'op-b',
				seedData: { a: 'seeded-a' },
			},
		);

		expect(result.steps.map((step) => step.key)).toEqual(['b']);
		expect(receivedContexts).toEqual(['seeded-a']);
	});

	test('invokes onStep after every executed operation', async () => {
		const manager = getFlowManager();

		const a = op('op-a', 'a');
		const flow = { ...flowWithOperations, operation: a } as unknown as Flow;

		manager.addOperation('mock-op-a', async () => 'result-a');

		const onStep = vi.fn();
		await manager.runDebugFlow(flow, null, {}, { onStep });

		expect(onStep).toHaveBeenCalledTimes(1);
		expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ key: 'a', data: 'result-a' }));
	});

	test('throws when the resume operation is not part of the flow', async () => {
		const manager = getFlowManager();

		const a = op('op-a', 'a');
		const flow = { ...flowWithOperations, operation: a } as unknown as Flow;
		manager.addOperation('mock-op-a', async () => null);

		await expect(manager.runDebugFlow(flow, null, {}, { startAtOperation: 'op-missing' })).rejects.toMatchObject({
			code: 'FORBIDDEN',
		});
	});
});
