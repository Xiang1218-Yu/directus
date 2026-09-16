import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FlowRunRecorder } from './flow-run-recorder.js';

vi.mock('../logger/index.js', () => ({
	useLogger: vi.fn().mockReturnValue({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

interface TableMock {
	inserts: any[];
	updates: any[];
	failInsert?: boolean;
	failUpdate?: boolean;
}

function createKnexMock(options: { runs?: Partial<TableMock>; nodes?: Partial<TableMock> } = {}) {
	const tables: {
		directus_flow_runs: TableMock;
		directus_flow_run_nodes: TableMock;
	} = {
		directus_flow_runs: { inserts: [], updates: [], ...options.runs },
		directus_flow_run_nodes: { inserts: [], updates: [], ...options.nodes },
	};

	const knex = vi.fn((table: string) => {
		const state = tables[table as keyof typeof tables];

		const builder: any = {};

		builder.insert = vi.fn((row) => {
			if (state?.failInsert) return Promise.reject(new Error('db down'));
			state?.inserts.push(row);
			return Promise.resolve();
		});

		builder.update = vi.fn((row) => {
			pendingUpdate = row;
			return builder;
		});

		builder.where = vi.fn(() => {
			if (state?.failUpdate) return Promise.reject(new Error('db down'));

			if (pendingUpdate !== undefined) {
				state?.updates.push(pendingUpdate);
				pendingUpdate = undefined;
			}

			return Promise.resolve(1);
		});

		let pendingUpdate: any;

		return builder;
	});

	(knex as any).fn = { now: vi.fn(() => 'NOW') };

	return { knex, tables };
}

describe('FlowRunRecorder', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	test('records a run lifecycle with redacted node input/output', async () => {
		const { knex, tables } = createKnexMock();

		const recorder = await FlowRunRecorder.start(knex as any, {
			flowId: 'flow-1',
			trigger: 'manual',
			userId: 'user-1',
		});

		expect(recorder).not.toBeNull();

		expect(tables['directus_flow_runs'].inserts[0]).toMatchObject({
			flow: 'flow-1',
			trigger: 'manual',
			status: 'running',
			user_created: 'user-1',
		});

		const nodeId = await recorder!.startNode({
			operationId: 'op-1',
			key: 'transform',
			type: 'transform',
			attempt: 1,
			input: {
				$trigger: { collection: 'articles', payload: { password: 'hunter2', name: 'public' } },
			},
		});

		expect(nodeId).toBeTruthy();

		expect(tables['directus_flow_run_nodes'].inserts[0]).toMatchObject({
			operation: 'op-1',
			operation_key: 'transform',
			operation_type: 'transform',
			attempt: 1,
			status: 'running',
		});

		// Sensitive values are redacted before persistence
		const storedInput = tables['directus_flow_run_nodes'].inserts[0]!.input_summary;
		expect(storedInput).not.toContain('hunter2');
		expect(storedInput).toContain('articles');

		// Whitelisted generic fields are retained in the output summary
		await recorder!.finishNode(nodeId, 'success', {
			output: { id: 'record-1', status: 200, secret: 'dropped' },
		});

		await recorder!.finish('success');

		expect(tables['directus_flow_run_nodes'].updates[0]).toMatchObject({ status: 'success' });
		const storedOutput = tables['directus_flow_run_nodes'].updates[0]!.output_summary;
		expect(storedOutput).toContain('record-1');
		expect(storedOutput).not.toContain('dropped');
		expect(tables['directus_flow_runs'].updates[0]).toMatchObject({ status: 'success' });
	});

	test('persists a sanitized error on failed nodes including retry attempts', async () => {
		const { knex, tables } = createKnexMock();

		const recorder = (await FlowRunRecorder.start(knex as any, {
			flowId: 'flow-1',
			trigger: 'webhook',
		}))!;

		const nodeId = await recorder.startNode({
			operationId: 'op-1',
			key: 'request',
			type: 'request',
			attempt: 2,
			input: null,
		});

		const error = Object.assign(new Error('request failed'), { stack: 'line1\nline2' });
		await recorder.finishNode(nodeId, 'failed', { error });

		const stored = tables['directus_flow_run_nodes'].updates[0]!;
		expect(stored.status).toBe('failed');
		expect(stored.error).toContain('request failed');
		expect(stored.error).not.toContain('line2');
	});

	test('returns null when the run row cannot be created instead of throwing', async () => {
		const { knex } = createKnexMock({ runs: { failInsert: true } });

		const recorder = await FlowRunRecorder.start(knex as any, {
			flowId: 'flow-1',
			trigger: 'manual',
		});

		expect(recorder).toBeNull();
	});

	test('node recording failures never reject the flow execution', async () => {
		const { knex } = createKnexMock({ nodes: { failInsert: true, failUpdate: true } });

		const recorder = (await FlowRunRecorder.start(knex as any, {
			flowId: 'flow-1',
			trigger: 'schedule',
		}))!;

		const nodeId = await recorder.startNode({
			operationId: 'op-1',
			key: 'x',
			type: 'noop',
			attempt: 1,
			input: {},
		});

		expect(nodeId).toBeNull();
		await expect(recorder.finishNode(null, 'failed', { error: new Error('x') })).resolves.toBeUndefined();
		await expect(recorder.finish('failed')).resolves.toBeUndefined();
	});
});
