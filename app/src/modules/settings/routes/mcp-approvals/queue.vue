<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsNavigation from '../../components/navigation.vue';
import api from '@/api';
import VButton from '@/components/v-button.vue';
import VCardText from '@/components/v-card-text.vue';
import VCardTitle from '@/components/v-card-title.vue';
import VCard from '@/components/v-card.vue';
import VChip from '@/components/v-chip.vue';
import VDialog from '@/components/v-dialog.vue';
import VError from '@/components/v-error.vue';
import VIcon from '@/components/v-icon/v-icon.vue';
import { unexpectedError } from '@/utils/unexpected-error';
import { PrivateView } from '@/views/private';

type ApprovalRow = {
	id: string;
	status: string;
	oauth_client: string | null;
	user: string;
	role: string | null;
	tool: string;
	action: string | null;
	collection: string | null;
	input_preview: unknown;
	result: unknown;
	review_note: string | null;
	policy: string | null;
	expires_at: string;
	requested_at: string;
	requested_by: string;
	reviewed_by: string | null;
	reviewed_at: string | null;
	completed_at: string | null;
	error: string | null;
};

const { t, locale } = useI18n();

const rows = ref<ApprovalRow[]>([]);
const loading = ref(false);
const error = ref<unknown>(null);
const filter = ref<string>('pending');
const actingOn = ref<string | null>(null);
const confirmAction = ref<{ id: string; decision: 'approve' | 'reject' } | null>(null);
const detail = ref<ApprovalRow | null>(null);

const filters = ['pending', 'approved', 'executing', 'completed', 'rejected', 'expired', 'cancelled', 'failed'];

const dateFormatter = computed(
	() =>
		new Intl.DateTimeFormat(locale.value, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}),
);

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchRows() {
	loading.value = true;
	error.value = null;

	try {
		const response = await api.get('/mcp-approvals', {
			params: filter.value === 'all' ? {} : { status: filter.value },
		});

		// Never let a processed row reappear as actionable: merge with what the user sees
		// and keep any terminal status we already rendered.
		const incoming = (response.data.data ?? []) as ApprovalRow[];
		const byId = new Map(rows.value.map((row) => [row.id, row]));

		rows.value = incoming.map((row) => {
			const previous = byId.get(row.id);

			if (previous && ['completed', 'rejected', 'failed', 'cancelled'].includes(previous.status)) {
				return previous.status === row.status ? row : previous;
			}

			return row;
		});
	} catch (err) {
		error.value = err;
	} finally {
		loading.value = false;
	}
}

async function decide() {
	if (!confirmAction.value) return;

	const { id, decision } = confirmAction.value;
	actingOn.value = id;

	try {
		await api.post(`/mcp-approvals/${id}/${decision}`);
		await fetchRows();
	} catch (err) {
		unexpectedError(err);
	} finally {
		actingOn.value = null;
		confirmAction.value = null;
	}
}

async function openDetail(row: ApprovalRow) {
	try {
		const response = await api.get(`/mcp-approvals/${row.id}`);
		detail.value = response.data.data;
	} catch (err) {
		unexpectedError(err);
	}
}

function statusColor(status: string): 'warning' | 'primary' | 'info' | 'success' | 'danger' | 'neutral' {
	return ({
		pending: 'warning',
		approved: 'primary',
		executing: 'info',
		completed: 'success',
		rejected: 'danger',
		expired: 'neutral',
		cancelled: 'neutral',
		failed: 'danger',
	}[status] ?? 'neutral') as 'warning' | 'primary' | 'info' | 'success' | 'danger' | 'neutral';
}

onMounted(() => {
	fetchRows();

	// Poll: pending decisions only. Every response is merged against already-terminal local
	// rows, so a refresh cannot resurface a processed record as actionable.
	pollTimer = setInterval(() => {
		if (filter.value === 'pending') fetchRows();
	}, 10_000);
});

onBeforeUnmount(() => {
	if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
	<PrivateView :title="$t('mcp_approvals')" icon="approval" show-back back-to="/settings/ai">
		<template #navigation>
			<SettingsNavigation />
		</template>

		<div class="queue">
			<div class="filters">
				<VChip
					v-for="value in ['all', ...filters]"
					:key="value"
					:active="filter === value"
					:kind="filter === value ? 'primary' : 'neutral'"
					clickable
					small
					@click="
						filter = value;
						fetchRows();
					"
				>
					{{ value === 'all' ? t('all') : t(`mcp_approval_status_${value}`) }}
				</VChip>
			</div>

			<div v-if="error" class="banner error">
				<VError :error="error" />
			</div>

			<div v-if="loading && rows.length === 0" class="empty">…</div>

			<VCard v-if="!loading && rows.length === 0" class="empty-card">
				<VCardText>
					<div class="empty">
						<VIcon name="inbox" />
						<p>{{ t('mcp_approvals_empty') }}</p>
					</div>
				</VCardText>
			</VCard>

			<VCard v-for="row in rows" :key="row.id" class="approval" @click="openDetail(row)">
				<header>
					<div class="meta">
						<strong>{{ row.tool }}</strong>
						<VChip small :kind="statusColor(row.status)">{{ t(`mcp_approval_status_${row.status}`) }}</VChip>
						<span v-if="row.action" class="dim">{{ row.action }}</span>
						<span v-if="row.collection" class="dim">{{ row.collection }}</span>
						<span v-if="row.oauth_client" class="dim">{{ row.oauth_client }}</span>
					</div>
					<div class="time dim">{{ dateFormatter.format(new Date(row.requested_at)) }}</div>
				</header>

				<VCardText>
					<pre class="preview">{{ JSON.stringify(row.input_preview, null, 2) }}</pre>
					<p v-if="row.error" class="error">{{ row.error }}</p>
				</VCardText>

				<div v-if="row.status === 'pending'" class="actions" @click.stop>
					<VButton
						kind="danger"
						outlined
						:loading="actingOn === row.id"
						@click.stop="confirmAction = { id: row.id, decision: 'reject' }"
					>
						{{ t('mcp_approval_reject') }}
					</VButton>
					<VButton :loading="actingOn === row.id" @click.stop="confirmAction = { id: row.id, decision: 'approve' }">
						{{ t('mcp_approval_approve') }}
					</VButton>
				</div>
			</VCard>
		</div>

		<VDialog :model-value="confirmAction !== null" @esc="confirmAction = null" @apply="decide">
			<VCard>
				<VCardTitle>
					{{
						confirmAction?.decision === 'approve'
							? t('mcp_approval_approve_confirm_title')
							: t('mcp_approval_reject_confirm_title')
					}}
				</VCardTitle>
				<VCardText>{{ t('mcp_approval_confirm_copy') }}</VCardText>
				<div class="dialog-actions">
					<VButton secondary @click="confirmAction = null">{{ t('cancel') }}</VButton>
					<VButton
						:kind="confirmAction?.decision === 'reject' ? 'danger' : 'normal'"
						:loading="actingOn !== null"
						@click="decide"
					>
						{{ confirmAction?.decision === 'approve' ? t('mcp_approval_approve') : t('mcp_approval_reject') }}
					</VButton>
				</div>
			</VCard>
		</VDialog>
		<VDialog :model-value="detail !== null" @esc="detail = null">
			<VCard v-if="detail" class="detail-card">
				<VCardTitle>
					{{ detail.tool }}
					<VChip small class="detail-chip" :kind="statusColor(detail.status)">
						{{ t(`mcp_approval_status_${detail.status}`) }}
					</VChip>
				</VCardTitle>

				<VCardText>
					<dl class="audit">
						<dt>{{ t('mcp_approval_field_id') }}</dt>
						<dd class="mono">{{ detail.id }}</dd>
						<dt>{{ t('mcp_approval_field_collection') }}</dt>
						<dd>{{ detail.collection ?? '—' }}</dd>
						<dt>{{ t('mcp_approval_field_action') }}</dt>
						<dd>{{ detail.action ?? '—' }}</dd>
						<dt>{{ t('mcp_approval_field_oauth_client') }}</dt>
						<dd class="mono">{{ detail.oauth_client ?? '—' }}</dd>
						<dt>{{ t('mcp_approval_field_requester') }}</dt>
						<dd class="mono">{{ detail.user }}</dd>
						<dt>{{ t('mcp_approval_field_requested') }}</dt>
						<dd>{{ dateFormatter.format(new Date(detail.requested_at)) }}</dd>
						<dt>{{ t('mcp_approval_field_expires') }}</dt>
						<dd>{{ dateFormatter.format(new Date(detail.expires_at)) }}</dd>
						<dt>{{ t('mcp_approval_field_reviewed_by') }}</dt>
						<dd class="mono">{{ detail.reviewed_by ?? '—' }}</dd>
						<dt v-if="detail.reviewed_at">{{ t('mcp_approval_field_reviewed_at') }}</dt>
						<dd v-if="detail.reviewed_at">{{ dateFormatter.format(new Date(detail.reviewed_at)) }}</dd>
						<dt v-if="detail.review_note">{{ t('mcp_approval_field_note') }}</dt>
						<dd v-if="detail.review_note">{{ detail.review_note }}</dd>
					</dl>

					<h4>{{ t('mcp_approval_field_parameters') }}</h4>
					<pre class="preview">{{ JSON.stringify(detail.input_preview, null, 2) }}</pre>

					<template v-if="detail.status === 'completed'">
						<h4>{{ t('mcp_approval_field_result') }}</h4>
						<pre class="preview">{{ JSON.stringify(detail.result, null, 2) }}</pre>
					</template>

					<p v-if="detail.error" class="error">{{ detail.error }}</p>
				</VCardText>

				<div class="dialog-actions">
					<VButton secondary @click="detail = null">{{ t('done') }}</VButton>
				</div>
			</VCard>
		</VDialog>
	</PrivateView>
</template>

<style lang="scss" scoped>
.queue {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: var(--theme--page-padding, 24px);
	max-width: 900px;
}

.filters {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
}

.approval {
	cursor: pointer;

	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 16px 0;
	}
}

.meta {
	display: flex;
	align-items: center;
	gap: 10px;
}

.dim {
	color: var(--theme--foreground-subdued);
	font-size: 0.9em;
}

.time {
	font-size: 0.85em;
}

.preview {
	background: var(--theme--background-subdued);
	padding: 10px;
	border-radius: 6px;
	overflow-x: auto;
	font-size: 0.85em;
	max-height: 260px;
	overflow-y: auto;
}

.actions,
.dialog-actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	padding: 0 16px 16px;
}

.error {
	color: var(--danger);
}

.empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 8px;
	padding: 48px;
	color: var(--theme--foreground-subdued);
}

.banner.error {
	padding: 12px 16px;
}

.detail-card {
	width: min(720px, 90vw);
	max-height: 86vh;
	overflow-y: auto;
}

.detail-chip {
	margin-left: 8px;
	vertical-align: middle;
}

.audit {
	display: grid;
	grid-template-columns: 160px 1fr;
	gap: 6px 16px;
	margin: 0 0 16px;

	dt {
		color: var(--theme--foreground-subdued);
		font-size: 0.85em;
	}

	dd {
		margin: 0;
		word-break: break-all;
	}
}

.mono {
	font-family: var(--theme--family-monospace, monospace);
	font-size: 0.85em;
}
</style>
