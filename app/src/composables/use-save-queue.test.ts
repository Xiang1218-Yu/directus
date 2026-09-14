import { describe, expect, it } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { useSaveQueue } from './use-save-queue';

function delayed() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => (resolve = res));
	return { promise, resolve };
}

describe('useSaveQueue', () => {
	it('runs enqueued work with the latest argument', async () => {
		const seen: (string | undefined)[] = [];

		const queue = useSaveQueue({
			run: async (arg) => {
				seen.push(arg);
			},
		});

		queue.enqueue('a');
		await nextTick();

		expect(seen).toEqual(['a']);
		expect(queue.isSaving.value).toBe(false);
	});

	it('coalesces work arriving while a save is in flight into one follow-up run', async () => {
		const calls: (number | undefined)[] = [];
		const first = delayed();
		let inFlight = false;

		const queue = useSaveQueue({
			run: async (arg) => {
				calls.push(arg);
				if (inFlight) return;
				inFlight = true;
				await first.promise;
			},
		});

		queue.enqueue(1);
		await nextTick();

		// Enqueued twice while the first run is in flight — both collapse into one run with arg 3.
		queue.enqueue(2);
		queue.enqueue(3);
		first.resolve();
		await first.promise;
		await nextTick();
		await nextTick();

		expect(calls).toEqual([1, 3]);
	});

	it('does not execute while disabled and stays pending until flushed when re-enabled', async () => {
		const enabled = ref(false);
		const calls: number[] = [];

		const queue = useSaveQueue({
			enabled: () => enabled.value,
			run: async (arg) => {
				calls.push(arg);
			},
		});

		queue.enqueue(1);
		await nextTick();
		expect(calls).toEqual([]);
		expect(queue.isPending.value).toBe(true);

		enabled.value = true;
		await expect(queue.flush()).resolves.toBe(true);
		expect(calls).toEqual([1]);
	});

	it('exposes the last failure via lastError and resolves flush() to false', async () => {
		const error = new Error('boom');

		const queue = useSaveQueue({
			run: async () => {
				throw error;
			},
		});

		queue.enqueue();
		await nextTick();

		expect(queue.lastError.value).toBe(error);
		await expect(queue.flush()).resolves.toBe(false);
	});

	it('clears lastError on the next successful run and flush() resolves true', async () => {
		let shouldFail = true;

		const queue = useSaveQueue({
			run: async () => {
				if (shouldFail) throw new Error('boom');
			},
		});

		queue.enqueue();
		await nextTick();
		expect(queue.lastError.value).not.toBe(null);

		shouldFail = false;
		queue.enqueue();
		await expect(queue.flush()).resolves.toBe(true);
		expect(queue.lastError.value).toBe(null);
	});

	it('awaits an in-flight run from flush() without starting a duplicate', async () => {
		const inFlight = delayed();
		const queue = useSaveQueue({ run: () => inFlight.promise });

		queue.enqueue();
		await nextTick();

		let settled = false;
		const flushed = queue.flush().then(() => (settled = true));

		await nextTick();
		expect(settled).toBe(false);

		inFlight.resolve();
		await flushed;
		expect(settled).toBe(true);
	});

	it('reset() drops pending work and the last error', async () => {
		const enabled = ref(false);
		const calls: number[] = [];

		const queue = useSaveQueue({
			enabled: () => enabled.value,
			run: async (arg) => {
				calls.push(arg);
			},
		});

		queue.enqueue(1);
		await nextTick();
		queue.reset();

		enabled.value = true;
		await queue.flush();
		expect(calls).toEqual([]);
	});

	it('stops scheduling when the owning scope is disposed mid-flight without throwing', async () => {
		const scope = effectScope();
		const inFlight = delayed();
		const queue = scope.run(() => useSaveQueue({ run: () => inFlight.promise }))!;

		queue.enqueue();
		await nextTick();
		scope.stop();
		inFlight.resolve();
		await inFlight.promise;
		await nextTick();

		expect(queue.isSaving.value).toBe(false);
	});
});
