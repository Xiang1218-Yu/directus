<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import SettingsNavigation from '../../components/navigation.vue';
import api from '@/api';
import VButton from '@/components/v-button.vue';
import VCardText from '@/components/v-card-text.vue';
import VCardTitle from '@/components/v-card-title.vue';
import VCard from '@/components/v-card.vue';
import VCheckbox from '@/components/v-checkbox.vue';
import VChip from '@/components/v-chip.vue';
import VDialog from '@/components/v-dialog.vue';
import VError from '@/components/v-error.vue';
import VIcon from '@/components/v-icon/v-icon.vue';
import VInput from '@/components/v-input.vue';
import VSelect from '@/components/v-select/v-select.vue';
import { unexpectedError } from '@/utils/unexpected-error';
import { PrivateView } from '@/views/private';

type Policy = {
	id: string;
	name: string;
	enabled: boolean;
	oauth_client: string | null;
	role: string | null;
	tool: string | null;
	timeout_minutes: number;
};

type Option = { text: string; value: string | null };

const { t } = useI18n();

const policies = ref<Policy[]>([]);
const clients = ref<Option[]>([]);
const roles = ref<Option[]>([]);
const loading = ref(false);
const error = ref<unknown>(null);

const editorOpen = ref(false);
const saving = ref(false);
const editing = ref<Policy | null>(null);
const draft = ref<Partial<Policy>>({});

const toolOptions = computed<Option[]>(() => [
	{ text: t('mcp_approval_policy_scope_any_write'), value: 'write' },
	{ text: t('mcp_approval_policy_scope_delete'), value: 'delete' },
	{ text: t('mcp_approval_policy_scope_all_tools'), value: null },
]);

async function fetchAll() {
	loading.value = true;
	error.value = null;

	try {
		const [policiesRes, clientsRes, rolesRes] = await Promise.all([
			api.get('/mcp-approval-policies', { params: { sort: 'name' } }),
			api.get('/mcp-oauth/clients', { params: { fields: ['client_id', 'client_name'], limit: -1 } }),
			api.get('/roles', { params: { fields: ['id', 'name'], limit: -1 } }),
		]);

		policies.value = policiesRes.data.data ?? [];

		clients.value = [
			{ text: t('mcp_approval_policy_any_client'), value: null },
			...(clientsRes.data.data ?? []).map((c: { client_id: string; client_name: string }) => ({
				text: c.client_name,
				value: c.client_id,
			})),
		];

		roles.value = [
			{ text: t('mcp_approval_policy_any_role'), value: null },
			...(rolesRes.data.data ?? []).map((r: { id: string; name: string }) => ({ text: r.name, value: r.id })),
		];
	} catch (err) {
		error.value = err;
	} finally {
		loading.value = false;
	}
}

function openCreate() {
	editing.value = null;
	draft.value = { enabled: true, tool: 'write', timeout_minutes: 60 };
	editorOpen.value = true;
}

function openEdit(policy: Policy) {
	editing.value = policy;
	draft.value = { ...policy };
	editorOpen.value = true;
}

async function save() {
	if (!draft.value.name?.trim()) return;

	saving.value = true;

	try {
		if (editing.value) {
			await api.patch(`/mcp-approval-policies/${editing.value.id}`, draft.value);
		} else {
			await api.post('/mcp-approval-policies', draft.value);
		}

		editorOpen.value = false;
		await fetchAll();
	} catch (err) {
		unexpectedError(err);
	} finally {
		saving.value = false;
	}
}

async function remove(policy: Policy) {
	try {
		await api.delete(`/mcp-approval-policies/${policy.id}`);
		await fetchAll();
	} catch (err) {
		unexpectedError(err);
	}
}

const timeoutValue = computed<number>({
	get: () => Number(draft.value.timeout_minutes ?? 60),
	set: (value) => {
		draft.value.timeout_minutes = value;
	},
});

onMounted(fetchAll);
</script>

<template>
	<PrivateView :title="$t('mcp_approval_policies')" icon="rule" show-back back-to="/settings/mcp-approvals">
		<template #navigation>
			<SettingsNavigation />
		</template>

		<div class="policies">
			<div v-if="error"><VError :error="error" /></div>

			<div class="toolbar">
				<VButton :loading="loading" @click="fetchAll">
					{{ t('mcp_approval_refresh') }}
				</VButton>
				<VButton @click="openCreate">
					<template #prepend><VIcon name="add" /></template>
					{{ t('mcp_approval_policy_create') }}
				</VButton>
			</div>

			<VCard v-if="!loading && policies.length === 0">
				<VCardText class="empty">{{ t('mcp_approval_policies_empty') }}</VCardText>
			</VCard>

			<VCard v-for="policy in policies" :key="policy.id" class="policy" clickable @click="openEdit(policy)">
				<header>
					<div class="meta">
						<strong>{{ policy.name }}</strong>
						<VChip small :kind="policy.enabled ? 'success' : 'neutral'">
							{{ policy.enabled ? t('enabled') : t('disabled') }}
						</VChip>
					</div>
					<VButton kind="danger" secondary icon :title="t('delete')" @click.stop="remove(policy)">
						<template #append><VIcon name="delete" /></template>
					</VButton>
				</header>

				<VCardText class="dim">
					{{ policy.tool ?? t('mcp_approval_policy_scope_all_tools') }}
					· {{ policy.oauth_client ?? t('mcp_approval_policy_any_client') }} ·
					{{ policy.role ?? t('mcp_approval_policy_any_role') }} · {{ policy.timeout_minutes }}m
				</VCardText>
			</VCard>
		</div>

		<VDialog :model-value="editorOpen" @esc="editorOpen = false">
			<VCard class="editor">
				<VCardTitle>{{ editing ? t('mcp_approval_policy_edit') : t('mcp_approval_policy_create') }}</VCardTitle>

				<VCardText>
					<div class="field">
						<label>{{ t('name') }}</label>
						<VInput v-model="draft.name" :placeholder="t('mcp_approval_policy_name_placeholder')" />
					</div>

					<div class="field">
						<label>{{ t('scope') }}</label>
						<VSelect v-model="draft.tool" :items="toolOptions" />
					</div>

					<div class="field">
						<label>{{ t('mcp_approval_field_oauth_client') }}</label>
						<VSelect v-model="draft.oauth_client" :items="clients" />
					</div>

					<div class="field">
						<label>{{ t('mcp_approval_field_role') }}</label>
						<VSelect v-model="draft.role" :items="roles" />
					</div>

					<div class="field">
						<label>{{ t('mcp_approval_field_timeout') }}</label>
						<VInput
							type="number"
							:min="1"
							:model-value="timeoutValue"
							@update:model-value="(value: string | number) => (draft.timeout_minutes = Number(value))"
						/>
					</div>

					<div class="field row">
						<VCheckbox v-model="draft.enabled" :label="t('enabled')" />
					</div>
				</VCardText>

				<div class="actions">
					<VButton secondary @click="editorOpen = false">{{ t('cancel') }}</VButton>
					<VButton :loading="saving" @click="save">{{ t('save') }}</VButton>
				</div>
			</VCard>
		</VDialog>
	</PrivateView>
</template>

<style lang="scss" scoped>
.policies {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: var(--theme--page-padding, 24px);
	max-width: 760px;
}

.toolbar {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
}

.policy {
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

.empty {
	padding: 32px;
	text-align: center;
}

.editor {
	width: min(520px, 90vw);
}

.field {
	margin-bottom: 14px;

	label {
		display: block;
		margin-bottom: 4px;
		font-size: 0.85em;
		color: var(--theme--foreground-subdued);
	}

	&.row {
		display: flex;
		align-items: center;
	}
}

.actions {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
	padding: 0 16px 16px;
}
</style>
