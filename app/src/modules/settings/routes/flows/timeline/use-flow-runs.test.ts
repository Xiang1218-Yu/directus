import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import { useFlowRunDetail, useFlowRuns } from './use-flow-runs';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/api', () => ({
	default: { get },
}));

vi.mock('@/utils/unexpected-error', () => ({
	unexpectedError: vi.fn(),
}));

describe('useFlowRuns', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		get.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('polls while a run is executing and stops once everything is finished', async () => {
		get.mockResolvedValueOnce({
			data: { data: [{ id: 'run-1', status: 'running' }], meta: { total: 1, total_pages: 1 } },
		});

		get.mockResolvedValueOnce({
			data: { data: [{ id: 'run-1', status: 'success' }], meta: { total: 1, total_pages: 1 } },
		});

		const { runs, getRuns } = useFlowRuns(ref('flow-1'));

		await getRuns();
		expect(runs.value[0]!.status).toBe('running');

		await vi.advanceTimersByTimeAsync(5_000);
		expect(get).toHaveBeenCalledTimes(2);
		expect(runs.value[0]!.status).toBe('success');

		// No more polling after the run completes
		await vi.advanceTimersByTimeAsync(20_000);
		expect(get).toHaveBeenCalledTimes(2);
	});

	test('marks the list as forbidden on a 403 and clears data', async () => {
		get.mockRejectedValueOnce({ response: { status: 403 } });

		const { forbidden, runs, getRuns } = useFlowRuns(ref('secret-flow'));

		await getRuns();

		expect(forbidden.value).toBe(true);
		expect(runs.value).toEqual([]);
	});
});

describe('useFlowRunDetail', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		get.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('keeps refreshing while nodes are running', async () => {
		get.mockResolvedValueOnce({
			data: {
				data: {
					id: 'run-1',
					status: 'running',
					nodes: [{ id: 'node-1', status: 'running' }],
				},
			},
		});

		get.mockResolvedValueOnce({
			data: {
				data: {
					id: 'run-1',
					status: 'success',
					nodes: [{ id: 'node-1', status: 'success' }],
				},
			},
		});

		const { run } = useFlowRunDetail(ref('run-1'));

		// The immediate watcher triggers the initial fetch synchronously
		expect(get).toHaveBeenCalledTimes(1);

		// Flush the mocked response, then let the polling interval fire once
		await vi.advanceTimersByTimeAsync(5_000);
		expect(get).toHaveBeenCalledTimes(2);
		expect(run.value?.status).toBe('success');

		// Polling stops once both the run and its nodes are finished
		await vi.advanceTimersByTimeAsync(20_000);
		expect(get).toHaveBeenCalledTimes(2);
	});

	test('marks the detail as forbidden on a 403', async () => {
		get.mockRejectedValueOnce({ response: { status: 403 } });

		const { forbidden } = useFlowRunDetail(ref('run-1'));

		await vi.runOnlyPendingTimersAsync();
		expect(forbidden.value).toBe(true);
	});
});
