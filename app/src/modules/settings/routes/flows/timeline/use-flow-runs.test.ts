import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { effectScope } from 'vue';
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

		const scope = effectScope();
		const { runs, getRuns } = scope.run(() => useFlowRuns(ref('flow-1')))!;

		await getRuns();
		expect(runs.value[0]!.status).toBe('running');

		await vi.advanceTimersByTimeAsync(5_000);
		expect(get).toHaveBeenCalledTimes(2);
		expect(runs.value[0]!.status).toBe('success');

		// No more polling after the run completes
		await vi.advanceTimersByTimeAsync(20_000);
		expect(get).toHaveBeenCalledTimes(2);

		scope.stop();
	});

	test('marks the list as forbidden on a 403 and clears data', async () => {
		get.mockRejectedValueOnce({ response: { status: 403 } });

		const scope = effectScope();
		const { forbidden, runs, getRuns } = scope.run(() => useFlowRuns(ref('secret-flow')))!;

		await getRuns();

		expect(forbidden.value).toBe(true);
		expect(runs.value).toEqual([]);

		scope.stop();
	});

	test('does not poll anymore after the composable scope is disposed (page unmount)', async () => {
		get.mockResolvedValue({
			data: { data: [{ id: 'run-1', status: 'running' }], meta: { total: 1, total_pages: 1 } },
		});

		const scope = effectScope();

		await scope.run(async () => {
			const { getRuns } = useFlowRuns(ref('flow-1'));
			await getRuns();
		});

		scope.stop();
		await vi.advanceTimersByTimeAsync(30_000);

		// Only the manual fetch happened; no interval requests survive the unmount
		expect(get).toHaveBeenCalledTimes(1);
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

		const scope = effectScope();
		const { run } = scope.run(() => useFlowRunDetail(ref('run-1')))!;

		// The immediate watcher triggers the initial fetch synchronously
		expect(get).toHaveBeenCalledTimes(1);

		// Flush the mocked response, then let the polling interval fire once
		await vi.advanceTimersByTimeAsync(5_000);
		expect(get).toHaveBeenCalledTimes(2);
		expect(run.value?.status).toBe('success');

		// Polling stops once both the run and its nodes are finished
		await vi.advanceTimersByTimeAsync(20_000);
		expect(get).toHaveBeenCalledTimes(2);

		scope.stop();
	});

	test('marks the detail as forbidden on a 403', async () => {
		get.mockRejectedValueOnce({ response: { status: 403 } });

		const scope = effectScope();
		const { forbidden } = scope.run(() => useFlowRunDetail(ref('run-1')))!;

		await vi.runOnlyPendingTimersAsync();
		expect(forbidden.value).toBe(true);

		scope.stop();
	});

	test('surfaces a 403 received while polling a still-running run and stops polling', async () => {
		get.mockResolvedValueOnce({
			data: {
				data: {
					id: 'run-1',
					status: 'running',
					nodes: [{ id: 'node-1', status: 'running' }],
				},
			},
		});

		get.mockRejectedValueOnce({ response: { status: 403 } });

		const scope = effectScope();

		const state = scope.run(() => useFlowRunDetail(ref('run-1')))!;

		// Flush the immediate watcher's initial fetch promise
		await Promise.resolve();
		await Promise.resolve();

		expect(get).toHaveBeenCalledTimes(1);
		expect(state.run.value?.status).toBe('running');

		// The poll interval fires; permission is revoked server-side
		await vi.advanceTimersByTimeAsync(5_000);

		expect(get).toHaveBeenCalledTimes(2);
		expect(state.forbidden.value).toBe(true);

		// After the denial the polling must not continue
		await vi.advanceTimersByTimeAsync(20_000);
		expect(get).toHaveBeenCalledTimes(2);

		scope.stop();
	});

	test('does not poll anymore after the composable scope is disposed (page unmount)', async () => {
		get.mockResolvedValue({
			data: {
				data: {
					id: 'run-1',
					status: 'running',
					nodes: [{ id: 'node-1', status: 'running' }],
				},
			},
		});

		const scope = effectScope();

		scope.run(() => {
			useFlowRunDetail(ref('run-1'));
		});

		scope.stop();
		await vi.advanceTimersByTimeAsync(30_000);

		// Only the immediate initial fetch happened; no interval requests survive unmount
		expect(get).toHaveBeenCalledTimes(1);
	});
});
