<script setup lang="ts">
import type { FlowRaw } from '@directus/types';
import { format, parseISO } from 'date-fns';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import RunDetail from './run-detail.vue';
import type { FlowRun } from './types';
import { useFlowRuns } from './use-flow-runs';
import VButton from '@/components/v-button.vue';
import VIcon from '@/components/v-icon/v-icon.vue';
import VPagination from '@/components/v-pagination.vue';
import VProgressCircular from '@/components/v-progress-circular.vue';
import { useFlowsStore } from '@/stores/flows';
import { usePermissionsStore } from '@/stores/permissions';
import { translate } from '@/utils/translate-literal';
import { PrivateView } from '@/views/private';

const props = defineProps<{
	primaryKey: string;
}>();

const { t } = useI18n();
const permissionsStore = usePermissionsStore();
const flowsStore = useFlowsStore();

const flow = computed<FlowRaw | undefined>(() => flowsStore.flows.find((entry) => entry.id === props.primaryKey));

const canReadFlows = computed(() => permissionsStore.hasPermission('directus_flows', 'read'));

const selectedRun = ref<FlowRun | null>(null);

const { runs, meta, loading, page, status, forbidden, getRuns } = useFlowRuns(computed(() => props.primaryKey));

const statusChoices = computed(() => [
	{ value: null, text: t('all_statuses') },
	{ value: 'running', text: t('run_status_running') },
	{ value: 'success', text: t('run_status_success') },
	{ value: 'failed', text: t('run_status_failed') },
]);

onMounted(getRuns);

function formatDate(value: string) {
	return format(parseISO(value), 'yyyy-MM-dd HH:mm:ss');
}
</script>

<template>
	<PrivateView
		:title="flow?.name ? `${translate(flow.name)} — ${$t('run_timeline')}` : $t('run_timeline')"
		icon="timeline"
		show-back
		:back-to="`/settings/flows/${primaryKey}`"
	>
		<template v-if="!canReadFlows || forbidden">
			<div class="empty-state">
				<VIcon name="block" class="empty-icon" />
				<p>{{ $t('run_timeline_no_access') }}</p>
			</div>
		</template>

		<template v-else>
			<div class="toolbar">
				<div class="filters">
					<div class="filter-group">
						<button
							v-for="choice in statusChoices"
							:key="choice.value ?? 'all'"
							class="filter"
							:class="{ active: status === choice.value }"
							@click="status = choice.value as any"
						>
							{{ choice.text }}
						</button>
					</div>
				</div>

				<VButton icon :loading="!!loading" @click="getRuns">
					<VIcon name="refresh" />
				</VButton>
			</div>

			<div v-if="loading && runs.length === 0" class="loading">
				<VProgressCircular indeterminate />
			</div>

			<div v-else-if="runs.length === 0" class="empty-state">
				<VIcon name="timeline" class="empty-icon" />
				<p>{{ status ? $t('run_timeline_empty_filtered') : $t('run_timeline_empty') }}</p>
			</div>

			<div v-else class="runs">
				<button v-for="run in runs" :key="run.id" class="run" :class="run.status" @click="selectedRun = run">
					<span class="status-icon">
						<VIcon v-if="run.status === 'success'" name="check_circle" color="var(--theme--primary)" />
						<VIcon v-else-if="run.status === 'failed'" name="cancel" color="var(--theme--danger)" />
						<span v-else class="running-dot" />
					</span>

					<span class="run-meta">
						<span class="run-trigger">{{ run.trigger }}</span>
						<span class="run-date">{{ formatDate(run.date_started) }}</span>
					</span>

					<span class="run-status-label">{{ $t(`run_status_${run.status}`) }}</span>
					<VIcon name="chevron_right" small />
				</button>
			</div>

			<VPagination v-if="meta && meta.total_pages > 1" v-model="page" :length="meta.total_pages" :total-visible="3" />

			<RunDetail :run="selectedRun" :flow="flow ?? null" @close="selectedRun = null" />
		</template>
	</PrivateView>
</template>

<style lang="scss" scoped>
.toolbar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 1rem;
	margin-block-end: 1.5rem;
}

.filter-group {
	display: inline-flex;
	border: var(--theme--border-width) solid var(--theme--border-color);
	border-radius: var(--theme--border-radius);
	overflow: hidden;
}

.filter {
	padding: 0.5rem 0.875rem;
	color: var(--theme--foreground-subdued);
	background-color: var(--theme--background);
	border: none;
	cursor: pointer;

	& + & {
		border-inline-start: var(--theme--border-width) solid var(--theme--border-color);
	}

	&.active {
		color: var(--theme--primary);
		background-color: var(--theme--primary-background);
	}
}

.loading,
.empty-state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0.75rem;
	padding: 4rem 1rem;
	color: var(--theme--foreground-subdued);
}

.empty-icon {
	--v-icon-size: 2rem;
}

.runs {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
}

.run {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	inline-size: 100%;
	padding: 0.75rem 1rem;
	text-align: start;
	background-color: var(--theme--background);
	border: var(--theme--border-width) solid var(--theme--border-color);
	border-radius: var(--theme--border-radius);
	cursor: pointer;
	transition: border-color var(--fast) var(--transition);

	&:hover {
		border-color: var(--theme--primary);
	}

	.status-icon {
		display: inline-flex;
		align-items: center;
	}

	.running-dot {
		inline-size: 1.125rem;
		block-size: 1.125rem;
		border-radius: 50%;
		background-color: var(--theme--warning);
		animation: pulse 1.5s ease-in-out infinite;
	}

	.run-meta {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}

	.run-trigger {
		font-weight: 600;
		text-transform: capitalize;
	}

	.run-date {
		color: var(--theme--foreground-subdued);
		font-size: 0.875rem;
	}

	.run-status-label {
		color: var(--theme--foreground-subdued);
		font-size: 0.8125rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
}

@keyframes pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.4;
	}
}

:deep(.v-pagination) {
	margin-block-start: 1.5rem;
}
</style>
