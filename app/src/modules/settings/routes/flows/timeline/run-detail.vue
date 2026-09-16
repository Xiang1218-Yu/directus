<script setup lang="ts">
import type { FlowRaw } from '@directus/types';
import { differenceInMilliseconds, format, parseISO } from 'date-fns';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FlowRun, FlowRunNode } from './types';
import { useFlowRunDetail } from './use-flow-runs';
import VDrawer from '@/components/v-drawer.vue';
import VIcon from '@/components/v-icon/v-icon.vue';
import VNotice from '@/components/v-notice.vue';
import VProgressCircular from '@/components/v-progress-circular.vue';
import { useExtensions } from '@/extensions';

const props = defineProps<{
	run: FlowRun | null;
	flow?: FlowRaw | null;
}>();

const emit = defineEmits(['close']);

const { t } = useI18n();
const { operations: operationExtensions } = useExtensions();

const runId = computed(() => props.run?.id ?? null);

const { run: runDetail, loading, forbidden, getRun } = useFlowRunDetail(runId);

// Local clock so running nodes display a ticking elapsed duration while polling refreshes state
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

watch(
	runDetail,
	(detail) => {
		const active = detail && (detail.status === 'running' || detail.nodes.some((node) => node.status === 'running'));

		if (active && clock === null) {
			clock = setInterval(() => (now.value = Date.now()), 1_000);
		} else if (!active && clock !== null) {
			clearInterval(clock);
			clock = null;
		}
	},
	{ immediate: true },
);

onBeforeUnmount(() => {
	if (clock !== null) {
		clearInterval(clock);
		clock = null;
	}
});

function resolveOperation(node: FlowRunNode) {
	const configured = props.flow?.operations.find((operation) => operation.id === node.operation);
	const extension = operationExtensions.value.find((operation) => operation.id === node.operation_type);

	return {
		name: configured?.name ?? node.operation_key,
		key: node.operation_key,
		typeLabel: extension?.name ?? node.operation_type,
	};
}

function formatTimestamp(value: string) {
	return format(parseISO(value), 'yyyy-MM-dd HH:mm:ss');
}

function formatDuration(node: FlowRunNode) {
	const end = node.date_finished ? parseISO(node.date_finished).getTime() : now.value;
	const ms = Math.max(0, differenceInMilliseconds(end, parseISO(node.date_started).getTime()));

	if (ms < 1_000) return `${ms}ms`;

	const seconds = Math.floor(ms / 1_000);
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

const expanded = ref<Set<string>>(new Set());

function toggle(id: string) {
	if (expanded.value.has(id)) expanded.value.delete(id);
	else expanded.value.add(id);

	// trigger reactivity for the Set mutation
	expanded.value = new Set(expanded.value);
}

watch(runId, () => (expanded.value = new Set()));
</script>

<template>
	<VDrawer
		:model-value="!!run"
		:title="run ? formatTimestamp(run.date_started) : t('run_timeline')"
		icon="timeline"
		@cancel="emit('close')"
	>
		<div class="content">
			<VNotice v-if="forbidden" type="danger">{{ t('run_timeline_no_access') }}</VNotice>

			<div v-else-if="loading && !runDetail" class="loading">
				<VProgressCircular indeterminate />
			</div>
			<template v-else-if="runDetail">
				<div class="run-header">
					<span class="status-badge" :class="runDetail.status">
						{{ t(`run_status_${runDetail.status}`) }}
					</span>
					<span class="trigger">{{ runDetail.trigger }}</span>
					<button class="refresh" :disabled="loading" @click="getRun">
						<VIcon name="refresh" small />
					</button>
				</div>

				<div v-if="runDetail.nodes.length === 0" class="empty">{{ t('run_timeline_no_nodes') }}</div>

				<ol v-else class="nodes">
					<li v-for="node in runDetail.nodes" :key="node.id" class="node">
						<div class="node-header" @click="toggle(node.id)">
							<span class="dot" :class="node.status">
								<span v-if="node.status === 'running'" class="pulse" />
							</span>

							<span class="node-title">
								<strong>{{ resolveOperation(node).name }}</strong>
								<span class="subdued">{{ resolveOperation(node).typeLabel }}</span>
							</span>

							<span v-if="node.attempt > 1" class="attempt">#{{ node.attempt }}</span>

							<span class="duration">
								{{ formatDuration(node) }}
								<VIcon v-if="node.status === 'running'" name="progress_activity" small class="spin" />
							</span>

							<VIcon name="expand_more" small :class="{ open: expanded.has(node.id) }" />
						</div>

						<div v-if="expanded.has(node.id)" class="node-body">
							<div class="times">
								<span>{{ t('run_node_started') }}: {{ formatTimestamp(node.date_started) }}</span>
								<span v-if="node.date_finished">
									{{ t('run_node_finished') }}: {{ formatTimestamp(node.date_finished) }}
								</span>
								<span v-else class="subdued">{{ t('run_node_still_running') }}</span>
							</div>

							<section v-if="node.input_summary !== null">
								<h4>{{ t('run_node_input') }}</h4>
								<pre class="json">{{ node.input_summary }}</pre>
							</section>

							<section v-if="node.output_summary !== null">
								<h4>{{ t('run_node_output') }}</h4>
								<pre class="json">{{ node.output_summary }}</pre>
							</section>

							<section v-if="node.error" class="error-section">
								<h4>{{ t('run_node_error') }}</h4>
								<pre class="json error">{{ node.error }}</pre>
							</section>
						</div>
					</li>
				</ol>
			</template>
		</div>
	</VDrawer>
</template>

<style lang="scss" scoped>
.content {
	padding: var(--content-padding);
}

.loading,
.empty {
	display: flex;
	justify-content: center;
	padding: 3rem 1rem;
	color: var(--theme--foreground-subdued);
	font-style: italic;
}

.run-header {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	margin-block-end: 1.5rem;
}

.status-badge {
	padding: 0.125rem 0.625rem;
	border-radius: 999px;
	font-size: 0.75rem;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.05em;

	&.running {
		background-color: var(--theme--warning-background, var(--theme--background-subdued));
		color: var(--theme--warning, var(--theme--foreground));
	}

	&.success {
		background-color: var(--theme--primary-background);
		color: var(--theme--primary);
	}

	&.failed {
		background-color: var(--theme--danger-background, var(--theme--background-subdued));
		color: var(--theme--danger);
	}
}

.trigger {
	text-transform: capitalize;
	color: var(--theme--foreground-subdued);
	flex: 1;
}

.refresh {
	display: inline-flex;
	padding: 0.375rem;
	border: none;
	background: none;
	color: var(--theme--foreground-subdued);
	cursor: pointer;

	&:hover {
		color: var(--theme--foreground);
	}
}

.nodes {
	list-style: none;
	margin: 0;
	padding: 0;
	position: relative;
}

.node {
	position: relative;
	padding-inline-start: 1.25rem;
	padding-block-end: 0.75rem;

	&::before {
		content: '';
		position: absolute;
		inline-size: 0.125rem;
		inset-inline-start: 0.4rem;
		inset-block: 1.125rem -0.25rem;
		background-color: var(--theme--border-color-subdued);
	}

	&:last-child::before {
		display: none;
	}
}

.node-header {
	display: flex;
	align-items: center;
	gap: 0.625rem;
	cursor: pointer;
	padding-block: 0.375rem;
}

.dot {
	position: absolute;
	inset-inline-start: 0;
	inline-size: 0.875rem;
	block-size: 0.875rem;
	border-radius: 50%;
	border: 2px solid var(--theme--background);
	background-color: var(--theme--primary);
	display: inline-flex;
	align-items: center;
	justify-content: center;

	&.failed {
		background-color: var(--theme--danger);
	}

	&.running {
		background-color: var(--theme--warning, #b8860b);
	}
}

.pulse {
	inline-size: 100%;
	block-size: 100%;
	border-radius: 50%;
	background-color: inherit;
	animation: pulse 1.5s ease-in-out infinite;
}

.node-title {
	flex: 1;
	display: flex;
	flex-direction: column;
	gap: 0.125rem;

	.subdued {
		color: var(--theme--foreground-subdued);
		font-size: 0.8125rem;
	}
}

.attempt {
	font-size: 0.75rem;
	font-weight: 600;
	color: var(--theme--danger);
}

.duration {
	display: inline-flex;
	align-items: center;
	gap: 0.25rem;
	color: var(--theme--foreground-subdued);
	font-size: 0.8125rem;
	font-variant-numeric: tabular-nums;
}

.spin {
	animation: spin 1.2s linear infinite;
}

.node-body {
	padding-block: 0.5rem 0.75rem;

	.times {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		font-size: 0.75rem;
		color: var(--theme--foreground-subdued);
		margin-block-end: 0.75rem;
	}

	section {
		margin-block-start: 0.75rem;
	}

	h4 {
		margin: 0 0 0.375rem;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--theme--foreground-subdued);
	}
}

.json {
	background-color: var(--theme--background-subdued);
	font-family: var(--theme--fonts--monospace--font-family);
	font-size: 0.8125rem;
	border-radius: var(--theme--border-radius);
	padding: 0.75rem;
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: break-word;
	max-block-size: 18rem;
	overflow: auto;

	&.error {
		color: var(--theme--danger);
	}
}

.subdued {
	color: var(--theme--foreground-subdued);
}

@keyframes spin {
	to {
		transform: rotate(360deg);
	}
}

@keyframes pulse {
	0%,
	100% {
		opacity: 1;
		transform: scale(1);
	}
	50% {
		opacity: 0.5;
		transform: scale(1.6);
	}
}
</style>
