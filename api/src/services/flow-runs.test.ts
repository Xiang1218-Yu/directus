import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchPermissions } from '../permissions/lib/fetch-permissions.js';
import { fetchPolicies } from '../permissions/lib/fetch-policies.js';
import { FlowRunsService } from './flow-runs.js';

vi.mock('@directus/env', () => ({
	useEnv: vi.fn().mockReturnValue({
		QUERY_LIMIT_DEFAULT: 100,
		QUERY_LIMIT_MAX: 100,
	}),
}));

vi.mock('../database/index.js', () => ({
	default: vi.fn(),
}));

vi.mock('../bus/index.js', () => ({
	useBus: vi.fn(() => ({ subscribe: vi.fn(), publish: vi.fn() })),
}));

vi.mock('../logger/index.js', () => ({
	useLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

const readByQuery = vi.fn();

vi.mock('./flows.js', () => ({
	FlowsService: vi.fn().mockImplementation(() => ({ readByQuery })),
}));

vi.mock('../permissions/lib/fetch-policies.js', () => ({
	fetchPolicies: vi.fn().mockResolvedValue(['policy-1']),
}));

vi.mock('../permissions/lib/fetch-permissions.js', () => ({
	fetchPermissions: vi.fn().mockResolvedValue([{ collection: 'directus_flows' }]),
}));

/**
 * Minimal knex query-builder mock. Builder methods stay chainable; terminal points (offset/first/
 * count) resolve to canned values, and a bare awaited chain (e.g. `await knex(t).select('id')`)
 * resolves via a thenable to `rows`.
 */
function createChain(terminals: { countRows?: { count: number | string }[]; rows?: any[]; firstRow?: any }) {
	const rows = terminals.rows ?? [];

	const chain: any = {
		andWhere: vi.fn(() => chain),
		where: vi.fn(() => chain),
		whereIn: vi.fn(() => chain),
		clearSelect: vi.fn(() => chain),
		clearOrder: vi.fn(() => chain),
		orderBy: vi.fn(() => chain),
		limit: vi.fn(() => chain),
		select: vi.fn(() => chain),
		count: vi.fn(() => Promise.resolve(terminals.countRows ?? [{ count: 0 }])),
		offset: vi.fn(() => Promise.resolve(rows)),
		first: vi.fn(() => Promise.resolve(terminals.firstRow ?? undefined)),
		then: (resolve: (value: any) => unknown) => resolve(rows),
	};

	chain.clone = vi.fn(() => chain);

	return chain;
}

const schema = { collections: { directus_flows: {} } } as any;

const adminAccountability = { admin: true, roles: [], user: 'admin-user' } as any;
const userAccountability = { admin: false, roles: ['role-1'], user: 'regular-user' } as any;

beforeEach(() => {
	vi.clearAllMocks();
	readByQuery.mockResolvedValue([{ id: 'allowed-flow' }]);
});

describe('FlowRunsService access control', () => {
	test('throws ForbiddenError for unauthenticated accountability', async () => {
		const knex = vi.fn();
		const service = new FlowRunsService({ knex: knex as any, schema, accountability: null });

		await expect(service.readByQuery({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(knex).not.toHaveBeenCalled();
	});

	test('throws ForbiddenError when the user has no read permission on directus_flows', async () => {
		vi.mocked(fetchPermissions).mockResolvedValueOnce([]);
		const knex = vi.fn();

		const service = new FlowRunsService({ knex: knex as any, schema, accountability: userAccountability });

		await expect(service.readByQuery({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
		expect(fetchPolicies).toHaveBeenCalled();
		expect(knex).not.toHaveBeenCalled();
	});

	test('scopes queries to permitted flows and applies the requested filters', async () => {
		vi.mocked(fetchPermissions).mockResolvedValueOnce([{ collection: 'directus_flows' }] as any);

		const runsChain = createChain({ countRows: [{ count: 0 }] });

		const knex = vi.fn((table: string) => {
			if (table === 'directus_flow_runs') return runsChain;
			return createChain({});
		});

		const service = new FlowRunsService({ knex: knex as any, schema, accountability: userAccountability });

		await service.readByQuery({ flow: 'allowed-flow', status: 'failed' });

		expect(knex).toHaveBeenCalledWith('directus_flow_runs');
		expect(runsChain.whereIn).toHaveBeenCalledWith('flow', ['allowed-flow']);
		expect(runsChain.andWhere).toHaveBeenCalledWith('flow', 'allowed-flow');
		expect(runsChain.andWhere).toHaveBeenCalledWith('status', 'failed');
	});

	test('does not leak the existence of a run belonging to a non-accessible flow', async () => {
		vi.mocked(fetchPermissions).mockResolvedValueOnce([{ collection: 'directus_flows' }] as any);

		const runsChain = createChain({ firstRow: { id: 'run-1', flow: 'secret-flow' } });
		const knex = vi.fn((table: string) => (table === 'directus_flow_runs' ? runsChain : createChain({})));

		const service = new FlowRunsService({ knex: knex as any, schema, accountability: userAccountability });

		await expect(service.readOne('run-1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	test('returns nodes of an allowed run ordered chronologically with attempts', async () => {
		const nodes = [
			{ id: 'node-2', operation_key: 'b', attempt: 1 },
			{ id: 'node-1', operation_key: 'a', attempt: 1 },
		];

		const runsChain = createChain({ firstRow: { id: 'run-1', flow: 'allowed-flow', status: 'success' } });
		const nodesChain = createChain({ rows: nodes });

		const knex = vi.fn((table: string) => {
			if (table === 'directus_flow_runs') return runsChain;
			if (table === 'directus_flow_run_nodes') return nodesChain;
			return createChain({});
		});

		const service = new FlowRunsService({ knex: knex as any, schema, accountability: userAccountability });

		const result = await service.readOne('run-1');

		expect(result.id).toBe('run-1');
		expect(nodesChain.where).toHaveBeenCalledWith('flow_run', 'run-1');
		expect(nodesChain.orderBy).toHaveBeenCalledWith('date_started', 'asc');
		expect(nodesChain.orderBy).toHaveBeenCalledWith('attempt', 'asc');
	});

	test('admins bypass the permission pipeline', async () => {
		const runsChain = createChain({
			countRows: [{ count: 11 }],
			rows: [{ id: 'run-1' }],
		});

		const flowsChain = createChain({ rows: [{ id: 'admin-flow' }] });

		const knex = vi.fn((table: string) => {
			if (table === 'directus_flow_runs') return runsChain;
			if (table === 'directus_flows') return flowsChain;
			return createChain({ rows: [] });
		});

		const service = new FlowRunsService({ knex: knex as any, schema, accountability: adminAccountability });

		const page = await service.readByQuery({ page: 2, limit: 10 });

		expect(fetchPermissions).not.toHaveBeenCalled();
		expect(runsChain.limit).toHaveBeenCalledWith(10);
		expect(runsChain.offset).toHaveBeenCalledWith(10);
		expect(page.meta).toMatchObject({ total: 11, page: 2, limit: 10, total_pages: 2 });
	});

	test('rejects an invalid status filter', async () => {
		const knex = vi.fn(() => createChain({ rows: [] }));
		const service = new FlowRunsService({ knex: knex as any, schema, accountability: adminAccountability });

		// @ts-expect-error deliberately invalid status
		await expect(service.readByQuery({ status: 'bogus' })).rejects.toMatchObject({
			code: 'INVALID_QUERY',
		});
	});
});
