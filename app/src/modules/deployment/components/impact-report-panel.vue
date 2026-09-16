<script setup lang="ts">
import {
	createDeploymentImpactReport,
	type DeploymentImpactReportOutput,
	readDeploymentImpactReports,
	retryDeploymentImpactReport,
} from '@directus/sdk';
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import VButton from '@/components/v-button.vue';
import VIcon from '@/components/v-icon/v-icon.vue';
import VInfo from '@/components/v-info.vue';
import VProgressCircular from '@/components/v-progress-circular.vue';
import { sdk } from '@/sdk';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { unexpectedError } from '@/utils/unexpected-error';

interface Props {
	provider?: string;
	deploymentId?: string;
	deploymentRunId?: string;
	projectId?: string;
	providerConfigured?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	provider: undefined,
	deploymentId: undefined,
	deploymentRunId: undefined,
	projectId: undefined,
	providerConfigured: true,
});

const emit = defineEmits<{
	(event: 'select', reportId: string | null): void;
}>();

const userStore = useUserStore();
const permissionsStore = usePermissionsStore();

const canViewReports = computed(
	() =>
		userStore.isAdmin ||
		(permissionsStore.hasPermission('directus_deployments', 'read') &&
			permissionsStore.hasPermission('directus_deployment_runs', 'read')),
);

const reports = ref<DeploymentImpactReportOutput[]>([]);
const loading = ref(true);
const generating = ref(false);
const retryingId = ref<string | null>(null);
const selectedReportId = ref<string | null>(null);
const fileInput = ref<HTMLInputElement>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

const hasActiveWork = computed(() => reports.value.some((report) => ['pending', 'processing'].includes(report.status)));

function hasChanges(report: DeploymentImpactReportOutput) {
	const summary = report.result?.summary;
	if (!summary) return false;

	return (
		summary.collections > 0 ||
		summary.fields > 0 ||
		summary.relations > 0 ||
		summary.permissions > 0 ||
		summary.pending_migrations > 0
	);
}

const filteredReports = computed(() => {
	return reports.value.filter((report) => {
		if (props.deploymentRunId) return report.deployment_run === props.deploymentRunId;
		if (props.deploymentId) return report.deployment === props.deploymentId;
		if (props.projectId) return report.deployment_project === props.projectId;
		return report.deployment === null;
	});
});

async function loadReports() {
	if (!props.providerConfigured) return;

	loading.value = true;

	try {
		const filter: Record<string, unknown> = {};

		if (props.deploymentRunId) {
			filter['deployment_run'] = { _eq: props.deploymentRunId };
		} else if (props.deploymentId) {
			filter['deployment'] = { _eq: props.deploymentId };
		} else if (props.projectId) {
			filter['deployment_project'] = { _eq: props.projectId };
		} else {
			filter['deployment'] = { _null: true };
		}

		reports.value = await sdk.request(
			readDeploymentImpactReports({
				filter,
				sort: ['-date_created'],
				limit: 10,
			}),
		);

		updatePolling();
	} catch (error) {
		unexpectedError(error);
	} finally {
		loading.value = false;
	}
}

async function onFileSelected(event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	if (!file) return;

	generating.value = true;

	try {
		const snapshot = JSON.parse(await file.text());

		const report = await sdk.request(
			createDeploymentImpactReport({
				snapshot,
				...(props.deploymentRunId ? { deployment_run: props.deploymentRunId } : {}),
				...(props.projectId ? { deployment_project: props.projectId } : {}),
				...(props.deploymentId ? { deployment: props.deploymentId } : {}),
			}),
		);

		reports.value = [report, ...reports.value];
		updatePolling();
	} catch (error) {
		unexpectedError(error);
	} finally {
		generating.value = false;
		input.value = '';
	}
}

async function retry(report: DeploymentImpactReportOutput) {
	retryingId.value = report.id;

	try {
		const updated = await sdk.request(retryDeploymentImpactReport(report.id));
		reports.value = reports.value.map((item) => (item.id === updated.id ? updated : item));
		updatePolling();
	} catch (error) {
		unexpectedError(error);
	} finally {
		retryingId.value = null;
	}
}

function updatePolling() {
	if (hasActiveWork.value) {
		if (!pollTimer) pollTimer = setInterval(loadReports, 3000);
	} else if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

function formatDate(value: string | null) {
	return value ? new Date(value).toLocaleString() : '—';
}

watch(filteredReports, (items) => {
	const completed = items.find((item) => item.status === 'completed' && item.result);
	const nextId = completed?.id ?? null;

	if (selectedReportId.value !== nextId) {
		selectedReportId.value = nextId;
		emit('select', nextId);
	}
}, { immediate: true });

onMounted(() => {
	if (canViewReports.value && props.providerConfigured) loadReports();
});

watch(
	() => [props.provider, props.deploymentId, props.deploymentRunId, props.providerConfigured],
	() => {
		if (props.providerConfigured) loadReports();
	},
);

onUnmounted(() => {
	if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
	<section v-if="canViewReports" class="impact-report">
		<div class="header">
			<div>
				<h3>{{ $t('deployment.impact_report.title') }}</h3>
				<p>{{ $t('deployment.impact_report.description') }}</p>
			</div>

			<VButton
				v-if="userStore.isAdmin"
				icon="upload_file"
				:loading="generating"
				@click="fileInput?.click()"
			>
				{{ $t('deployment.impact_report.generate') }}
			</VButton>

			<input ref="fileInput" hidden type="file" accept="application/json,.json" @change="onFileSelected" />
		</div>

		<VInfo v-if="!providerConfigured" icon="cloud_off" :title="$t('deployment.impact_report.provider_unconfigured')">
			{{ $t('deployment.impact_report.provider_unconfigured_copy') }}
		</VInfo>

		<VProgressCircular v-else-if="loading" indeterminate small />

		<VInfo v-else-if="filteredReports.length === 0" icon="fact_check" :title="$t('deployment.impact_report.empty')">
			{{ $t('deployment.impact_report.empty_copy') }}
		</VInfo>

		<div v-else class="reports">
			<article v-for="report in filteredReports" :key="report.id" class="report-card" :class="report.status">
				<div class="report-header">
					<VIcon :name="report.status === 'completed' ? 'check_circle' : report.status === 'failed' || report.status === 'expired' ? 'error' : 'pending'" />
					<span>{{ $t(`deployment.impact_report.status.${report.status}`) }}</span>
					<time>{{ formatDate(report.completed_at ?? report.date_created) }}</time>
				</div>

				<div v-if="report.status === 'completed' && report.result" class="summary">
					<VInfo
						v-if="!hasChanges(report)"
						type="success"
						icon="check_circle"
						:title="$t('deployment.impact_report.no_changes')"
					>
						{{ $t('deployment.impact_report.no_changes_copy') }}
					</VInfo>

					<template v-else>
						<div>
							<strong>{{ report.result.summary.collections }}</strong>
							<span>{{ $t('deployment.impact_report.collections') }}</span>
						</div>
						<div>
							<strong>{{ report.result.summary.fields }}</strong>
							<span>{{ $t('deployment.impact_report.fields') }}</span>
						</div>
						<div v-if="report.result.summary.affected_records !== undefined">
							<strong>{{ report.result.summary.affected_records }}</strong>
							<span>{{ $t('deployment.impact_report.records') }}</span>
						</div>
						<div>
							<strong>{{ report.result.summary.pending_migrations }}</strong>
							<span>{{ $t('deployment.impact_report.migrations') }}</span>
						</div>
					</template>
				</div>

				<p v-else-if="report.status === 'pending' || report.status === 'processing'" class="muted">
					{{ $t('deployment.impact_report.generating') }}
				</p>

				<div v-else-if="report.status === 'failed' || report.status === 'expired'" class="error">
					<p>{{ $t(`deployment.impact_report.${report.status}_copy`) }}</p>
					<p v-if="report.error" class="message">{{ report.error }}</p>
					<VButton small :loading="retryingId === report.id" @click="retry(report)">
						{{ $t('deployment.impact_report.retry') }}
					</VButton>
				</div>

				<ul v-if="report.result?.collections?.length" class="collection-list">
					<li v-for="item in report.result.collections.slice(0, 5)" :key="item.collection">
						<span>{{ item.collection }}</span>
						<span>{{ $t(`deployment.impact_report.action.${item.action}`) }}</span>
						<span v-if="item.record_count !== undefined">{{ item.record_count }}</span>
						<span v-else-if="!item.accessible" class="muted">{{ $t('deployment.impact_report.restricted') }}</span>
					</li>
				</ul>
			</article>
		</div>
	</section>
</template>

<style scoped lang="scss">
.impact-report {
	border: var(--theme--border-width) solid var(--theme--border-color);
	border-radius: var(--theme--border-radius);
	padding: 1rem;
	margin-block-end: 1.5rem;
}

.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	margin-block-end: 1rem;

	h3 {
		margin: 0;
	}

	p {
		margin: 0.25rem 0 0;
		color: var(--theme--foreground-subdued);
		font-size: 0.8125rem;
	}
}

.reports {
	display: grid;
	gap: 0.75rem;
}

.report-card {
	background: var(--theme--background-subdued);
	border-radius: var(--theme--border-radius);
	padding: 0.875rem;

	&.completed {
		border-inline-start: 3px solid var(--theme--success);
	}

	&.failed,
	&.expired {
		border-inline-start: 3px solid var(--theme--danger);
	}

	&.pending,
	&.processing {
		border-inline-start: 3px solid var(--theme--warning);
	}
}

.report-header {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	font-weight: 600;

	time {
		margin-inline-start: auto;
		font-weight: 400;
		color: var(--theme--foreground-subdued);
		font-size: 0.75rem;
	}
}

.summary {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: 0.75rem;
	margin-block: 0.75rem;

	div {
		display: flex;
		flex-direction: column;
	}

	strong {
		font-size: 1.25rem;
	}

	span {
		color: var(--theme--foreground-subdued);
		font-size: 0.75rem;
	}
}

.muted,
.message {
	color: var(--theme--foreground-subdued);
	font-size: 0.8125rem;
}

.error {
	margin-block-start: 0.5rem;
}

.collection-list {
	list-style: none;
	padding: 0;
	margin: 0.75rem 0 0;
	border-top: var(--theme--border-width) solid var(--theme--border-color);

	li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		gap: 0.75rem;
		padding: 0.375rem 0;
		font-size: 0.8125rem;
	}
}
</style>
