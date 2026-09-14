import { readonly, ref } from 'vue';

export interface SaveQueueOptions {
	/**
	 * Called with the queued argument. Must resolve when the save is durable and reject when it
	 * failed; failed work is dropped from the queue (the caller — e.g. auto-save — owns retry
	 * policy and can re-enqueue) and the rejection is exposed via `lastError`.
	 */
	run: (arg?: any) => Promise<void>;
	/** Returns false when queued work must not execute right now (e.g. permissions/context gone). */
	enabled?: () => boolean;
}

/**
 * Serialized, single-slot save queue shared by manual saves and auto-save.
 *
 * Boundary contract:
 * - Exactly one save runs at a time; work arriving while one is in flight collapses into one
 *   follow-up run (latest argument wins).
 * - The result of the last run is exposed via `lastError` (cleared on the next success); failed
 *   work is *not* silently retried — scheduling retries is the caller's policy decision.
 * - `flush` drains pending/in-flight work and resolves to `false` when a run failed, so callers
 *   like Publish can abort without re-implementing the drain loop.
 * - No timers, debounce or notifications live here — those are policy concerns of the caller.
 */
export function useSaveQueue(options: SaveQueueOptions) {
	const { run, enabled } = options;

	const isSaving = ref(false);
	const isPending = ref(false);
	const lastError = ref<Error | null>(null);

	let pendingArg: any = undefined;
	let activeRun: Promise<void> | null = null;

	function enqueue(arg?: any) {
		// Keep the work marked pending even while disabled; kick() won't run it until the context
		// is enabled again (a subsequent enqueue/flush starts it).
		pendingArg = arg;
		isPending.value = true;
		void kick();
	}

	/** Runs pending work immediately if nothing is in flight; otherwise the in-flight run drains it. */
	async function flush(): Promise<boolean> {
		if (enabled && !enabled()) return true;

		if (activeRun) await activeRun;
		else if (isPending.value) await kick();

		return !lastError.value;
	}

	async function kick(): Promise<void> {
		if (activeRun) return;
		if (!isPending.value) return;
		if (enabled && !enabled()) return;

		const arg = pendingArg;
		isPending.value = false;
		pendingArg = undefined;
		isSaving.value = true;

		activeRun = (async () => {
			try {
				await run(arg);
				lastError.value = null;
			} catch (error) {
				lastError.value = error instanceof Error ? error : new Error(String(error));
			} finally {
				isSaving.value = false;
				activeRun = null;
			}
		})();

		await activeRun;

		if (isPending.value) void kick();
	}

	function reset() {
		isPending.value = false;
		pendingArg = undefined;
		lastError.value = null;
	}

	return {
		isSaving: readonly(isSaving),
		isPending: readonly(isPending),
		lastError: readonly(lastError),
		enqueue,
		flush,
		reset,
	};
}
