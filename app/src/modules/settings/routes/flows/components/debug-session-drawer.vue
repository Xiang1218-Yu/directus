<script setup lang="ts">
import type { FlowRaw, FlowSessionRaw, FlowSessionStatus, FlowSessionStep } from '@directus/types';
import { computed } from 'vue';
import VButton from '@/components/v-button.vue';
import VDetail from '@/components/v-detail.vue';
import VDrawer from '@/components/v-drawer.vue';
import VIcon from '@/components/v-icon/v-icon.vue';
import VNotice from '@/components/v-notice.vue';
import VProgressLinear from '@/components/v-progress-linear.vue';
import { useExtensions } from '@/extensions';

const props = defineProps<{
	flow: FlowRaw;
	session: FlowSessionRaw | null;
	pending: boolean;
	runningCount: number;
}>();

const emit = defineEmits<{
	close: [];
	rerun: [sessionId: string, operation: string | null, input?: unknown];
	cancel: [sessionId: string];
	mark: [sessionId: string, status: FlowSessionStatus];
	delete: [sessionId: string];
}>();

const { operations } = useExtensions();

const isRunning = computed(() => props.session?.status === 'running');
const isCancelling = computed(() => props.session?.status === 'cancelling');
const isActive = computed(() => isRunning.value || isCancelling.value);

const isTerminal = computed(() =>
	props.session ? ['succeeded', 'failed', 'cancelled'].includes(props.session.status) : false,
);

const failedStep = computed(() => {
	if (!props.session) return null;
	return [...props.session.steps].reverse().find((step) => step.status === 'reject') ?? null;
});

const steps = computed(() => {
	if (!props.session) return [];

	return props.session.steps.map((step: FlowSessionStep) => {
		const operationConfig = props.flow.operations.find((operation) => operation.id === step.operation);
		const operationType = operations.value.find((operation) => operation.id === operationConfig?.type);

		return {
			id: step.operation,
			key: step.key,
			status: step.status,
			name: operationConfig?.name ?? step.key,
			type: operationType?.name ?? operationConfig?.type ?? '--',
			options: step.options,
			data: step.data,
		};
	});
});

function stringify(value: unknown): string {
	if (value === undefined) return 'null';
	return JSON.stringify(value, null, 2);
}

function formatDate(value: string | null): string {
	if (!value) return '--';
	return new Date(value).toLocaleString();
}

function rerunRemaining() {
	if (!props.session) return;
	emit('rerun', props.session.id, failedStep.value?.operation ?? null);
}

function rerunAll() {
	if (!props.session) return;
	emit('rerun', props.session.id, null);
}
</script>

<template>
	<VDrawer
		:model-value="!!session"
		:title="session?.name || $t('debug_session')"
		icon="bug_report"
		@cancel="emit('close')"
	>
		<div v-if="session" class="content">
			<header class="header">
				<div class="status">
					<VIcon
						:name="
							session.status === 'succeeded'
								? 'check_circle'
								: session.status === 'failed'
									? 'cancel'
									: session.status === 'cancelled'
										? 'block'
										: session.status === 'cancelling'
											? 'hourglass_top'
											: 'pending'
						"
						:color="
							session.status === 'succeeded'
								? 'var(--theme--primary)'
								: session.status === 'failed'
									? 'var(--theme--danger)'
									: 'var(--theme--foreground-subdued)'
						"
					/>
					<span>{{ $t(`flow_session_status_${session.status}`) }}</span>
				</div>

				<div class="meta">
					<span>{{ $t('attempts_count', { count: session.attempts }) }}</span>
					<span>{{ formatDate(session.started_at) }}</span>
				</div>
			</header>

			<VProgressLinear v-if="isActive" indeterminate />

			<footer v-if="isCancelling" class="toolbar">
				<VNotice icon="hourglass_top">{{ $t('session_cancelling_notice') }}</VNotice>
			</footer>

			<footer class="toolbar">
				<template v-if="isRunning">
					<VButton kind="danger" :loading="pending" @click="emit('cancel', session.id)">
						<VIcon name="block" small />
						{{ $t('cancel_run') }}
					</VButton>
				</template>

				<template v-else-if="isTerminal">
					<VButton :loading="pending" @click="rerunAll">
						<VIcon name="replay" small />
						{{ $t('rerun_from_trigger') }}
					</VButton>

					<VButton v-if="failedStep" secondary :loading="pending" @click="rerunRemaining">
						<VIcon name="play_arrow" small />
						{{ $t('rerun_remaining_branch') }}
					</VButton>
				</template>
			</footer>

			<footer v-if="isTerminal" class="toolbar mark-actions">
				<span class="label">{{ $t('mark_session_as') }}</span>
				<VButton
					small
					:class="{ active: session.status === 'succeeded' }"
					:disabled="pending"
					@click="emit('mark', session.id, 'succeeded')"
				>
					{{ $t('successful') }}
				</VButton>
				<VButton
					small
					kind="danger"
					:class="{ active: session.status === 'failed' }"
					:disabled="pending"
					@click="emit('mark', session.id, 'failed')"
				>
					{{ $t('failed_label') }}
				</VButton>
				<VButton
					small
					secondary
					:class="{ active: session.status === 'cancelled' }"
					:disabled="pending"
					@click="emit('mark', session.id, 'cancelled')"
				>
					{{ $t('canceled') }}
				</VButton>
				<VButton small kind="danger" :loading="pending" @click="emit('delete', session.id)">
					<VIcon name="delete" small />
				</VButton>
			</footer>

			<div class="steps">
				<div class="step trigger">
					<div class="header">
						<span class="dot" />
						<span class="type-label">{{ $t('trigger') }}</span>
					</div>
					<div class="inset">
						<VDetail :label="$t('test_input')">
							<pre class="json">{{ stringify(session.input) }}</pre>
						</VDetail>
					</div>
				</div>

				<div v-if="steps.length === 0 && isActive" class="empty-state">{{ $t('waiting_for_first_node') }}</div>
				<div v-else-if="steps.length === 0" class="empty-state">{{ $t('no_nodes_executed') }}</div>

				<div v-for="step of steps" :key="`${step.id}-${step.key}`" class="step">
					<div class="header">
						<span class="dot" :class="step.status" />
						<span v-tooltip="step.key" class="type-label">
							{{ step.name }}
							<span class="subdued">&nbsp;{{ step.type }}</span>
						</span>
						<VButton
							v-if="isTerminal"
							small
							class="rerun-node"
							:title="$t('rerun_from_node')"
							@click="emit('rerun', session.id, step.id)"
						>
							<VIcon name="replay" small />
						</VButton>
					</div>

					<div class="inset">
						<VDetail v-if="step.options && Object.keys(step.options).length > 0" :label="$t('options')">
							<pre class="json">{{ stringify(step.options) }}</pre>
						</VDetail>

						<VDetail :label="$t('output')">
							<pre class="json" :class="{ rejected: step.status === 'reject' }">{{ stringify(step.data) }}</pre>
						</VDetail>
					</div>
				</div>
			</div>

			<VDetail v-if="session.error" :label="$t('final_error')" class="error-detail">
				<pre class="json error">{{ stringify(session.error) }}</pre>
			</VDetail>

			<div v-if="session.completed_at" class="completed">
				{{ $t('completed_at', { date: formatDate(session.completed_at) }) }}
			</div>
		</div>
	</VDrawer>
</template>

<style lang="scss" scoped>
.content {
	padding: var(--content-padding);
}

.header {
	display: flex;
	flex-direction: column;
	gap: 0.375rem;
	margin-block-end: 0.75rem;
}

.status {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	font-weight: 600;
}

.meta {
	display: flex;
	gap: 1rem;
	color: var(--theme--foreground-subdued);
	font-size: var(--font-size-1);
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	gap: 0.5rem;
	margin: 0.75rem 0;
}

.mark-actions {
	align-items: center;

	.label {
		color: var(--theme--foreground-subdued);
		font-size: var(--font-size-1);
	}

	.active {
		outline: 2px solid var(--theme--primary);
	}
}

.steps {
	position: relative;
	margin-block-start: 1rem;
}

.step {
	position: relative;

	&::after {
		content: '';
		position: absolute;
		inline-size: var(--theme--border-width);
		inset-inline-start: -0.625rem;
		inset-block-start: 0;
		background-color: var(--theme--border-color-subdued);
		block-size: 100%;
	}

	&:last-child::after {
		block-size: 0.6875rem;
	}

	.header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.rerun-node {
		margin-inline-start: auto;
	}

	.inset {
		padding-block: 0.5rem 1.25rem;

		.v-detail + .v-detail {
			margin-block-start: 0.6875rem;
		}
	}

	.subdued {
		color: var(--theme--foreground-subdued);
	}
}

.dot {
	display: inline-block;
	inline-size: 0.6875rem;
	block-size: 0.6875rem;
	background-color: var(--theme--primary);
	border: var(--theme--border-width) solid var(--theme--background);
	border-radius: 50%;

	&.resolve {
		background-color: var(--theme--primary);
	}

	&.reject {
		background-color: var(--theme--danger);
	}

	&.unknown {
		background-color: var(--theme--warning);
	}
}

.json {
	background-color: var(--theme--background-subdued);
	font-family: var(--theme--fonts--monospace--font-family);
	border-radius: var(--theme--border-radius);
	padding: 1rem;
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: break-word;
	max-block-size: 24rem;
	overflow: auto;

	&.rejected,
	&.error {
		border-inline-start: 3px solid var(--theme--danger);
	}
}

.empty-state {
	color: var(--theme--foreground-subdued);
	font-style: italic;
	padding: 0.5rem 0 1rem;
}

.error-detail {
	margin-block-start: 1rem;
}

.completed {
	margin-block-start: 1rem;
	color: var(--theme--foreground-subdued);
	font-size: var(--font-size-1);
}
</style>
