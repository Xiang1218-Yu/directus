import type { Ref } from 'vue';
import { computed, onScopeDispose, ref, watch } from 'vue';
import type { FlowRun, FlowRunDetail, FlowRunsMeta, FlowRunStatus } from './types';
import api from '@/api';
import { unexpectedError } from '@/utils/unexpected-error';

const REFRESH_INTERVAL = 5_000;

export function useFlowRuns(flowId: Ref<string>) {
	const runs = ref<FlowRun[]>([]);
	const meta = ref<FlowRunsMeta | null>(null);
	const loading = ref(false);
	const page = ref(1);
	const status = ref<FlowRunStatus | null>(null);
	const forbidden = ref(false);

	let timer: ReturnType<typeof setInterval> | null = null;

	const hasRunning = computed(() => runs.value.some((run) => run.status === 'running'));

	async function getRuns() {
		loading.value = true;
		forbidden.value = false;

		try {
			const response = await api.get('/flow-runs', {
				params: {
					flow: flowId.value,
					page: page.value,
					...(status.value ? { status: status.value } : {}),
				},
			});

			runs.value = response.data.data;
			meta.value = response.data.meta;
		} catch (err: any) {
			if (err?.response?.status === 403) {
				forbidden.value = true;
				runs.value = [];
				meta.value = null;
			} else {
				unexpectedError(err);
			}
		} finally {
			loading.value = false;
		}
	}

	watch([page, status], () => {
		getRuns();
	});

	/**
	 * Poll while the list contains runs that may still be executing. Long-running runs keep their
	 * "running" state until the flow finishes, so the view refreshes itself without interaction.
	 */
	watch(
		hasRunning,
		(running) => {
			if (running && timer === null) {
				timer = setInterval(getRuns, REFRESH_INTERVAL);
			} else if (!running && timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
		{ immediate: true },
	);

	onScopeDispose(() => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	});

	return { runs, meta, loading, page, status, forbidden, getRuns };
}

export function useFlowRunDetail(runId: Ref<string | null>) {
	const run = ref<FlowRunDetail | null>(null);
	const loading = ref(false);
	const forbidden = ref(false);
	const error = ref<unknown>(null);

	let timer: ReturnType<typeof setInterval> | null = null;

	async function getRun() {
		if (!runId.value) {
			run.value = null;
			return;
		}

		loading.value = true;
		error.value = null;
		forbidden.value = false;

		try {
			const response = await api.get(`/flow-runs/${runId.value}`);
			run.value = response.data.data;
		} catch (err: any) {
			if (err?.response?.status === 403) {
				forbidden.value = true;
			} else {
				error.value = err;
				unexpectedError(err);
			}
		} finally {
			loading.value = false;
		}
	}

	// Keep refreshing while the run or any of its nodes is still executing. Access being
	// denied (e.g. permission revoked while polling) also stops the interval.
	watch(
		() => [run.value?.status, run.value?.nodes.some((node) => node.status === 'running'), forbidden.value],
		([status, nodeRunning, denied]) => {
			const active = !denied && (status === 'running' || nodeRunning === true);

			if (active && timer === null) {
				timer = setInterval(getRun, REFRESH_INTERVAL);
			} else if (!active && timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		},
		{ immediate: true },
	);

	watch(runId, getRun, { immediate: true });

	onScopeDispose(() => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	});

	return { run, loading, forbidden, error, getRun };
}
