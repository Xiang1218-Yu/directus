<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import api from '@/api';
import VButton from '@/components/v-button.vue';
import VNotice from '@/components/v-notice.vue';
import { usePermissionsStore } from '@/stores/permissions';
import { unexpectedError } from '@/utils/unexpected-error';
import { PrivateView } from '@/views/private';

interface QualityRule {
	id: string;
	name: string;
	description: string | null;
	collection: string;
	fields: string[];
	type: 'empty' | 'broken_relation';
	schedule: string | null;
	status: 'active' | 'inactive';
	version: number;
}

interface QualityRun {
	id: string;
	rule_version: number;
	status: string;
	trigger: string;
	scanned_count: number;
	finding_count: number;
	error: string | null;
	date_started: string;
	date_finished: string | null;
}

interface Finding {
	id: string;
	item: string;
	fields: string[];
	message: string | null;
}

const props = defineProps<{ primaryKey: string }>();
const router = useRouter();
const permissionsStore = usePermissionsStore();

const rule = ref<QualityRule | null>(null);
const runs = ref<QualityRun[]>([]);
const findings = ref<Finding[]>([]);
const loading = ref(true);
const running = ref(false);
const saving = ref(false);
const page = ref(1);
const total = ref(0);
const error = ref<string | null>(null);
const editing = ref(false);

const updateAllowed = computed(() => permissionsStore.hasPermission('directus_quality_rules', 'update'));
const deleteAllowed = computed(() => permissionsStore.hasPermission('directus_quality_rules', 'delete'));

const form = ref({
	name: '',
	description: '',
	collection: '',
	fields: '',
	type: 'empty',
	schedule: '',
	status: 'inactive',
});

async function hydrate() {
	loading.value = true;
	error.value = null;

	try {
		const [ruleResponse, runsResponse, findingsResponse] = await Promise.all([
			api.get(`/quality-rules/${props.primaryKey}`),
			api.get(`/quality-rules/${props.primaryKey}/runs`, {
				params: { sort: ['-date_started'], limit: 25 },
			}),
			api.get(`/quality-rules/${props.primaryKey}/findings`, {
				params: { limit: 25, page: page.value },
			}),
		]);

		const currentRule = ruleResponse.data.data as QualityRule;
		rule.value = currentRule;
		runs.value = runsResponse.data.data ?? [];

		findings.value = (findingsResponse.data.data ?? []).map((finding: Finding & { fields: string[] | string }) => ({
			...finding,
			fields: typeof finding.fields === 'string' ? JSON.parse(finding.fields) : finding.fields,
		}));

		total.value = findingsResponse.data.meta?.total_count ?? 0;

		form.value = {
			name: currentRule.name,
			description: currentRule.description ?? '',
			collection: currentRule.collection,
			fields: currentRule.fields.join(', '),
			type: currentRule.type,
			schedule: currentRule.schedule ?? '',
			status: currentRule.status,
		};
	} catch (err) {
		unexpectedError(err);
		error.value = 'Could not load the quality rule.';
	} finally {
		loading.value = false;
	}
}

async function runNow() {
	if (running.value) return;
	running.value = true;
	error.value = null;

	try {
		await api.post(`/quality-rules/${props.primaryKey}/run`);
		await new Promise((resolve) => setTimeout(resolve, 700));
		await hydrate();
		setTimeout(hydrate, 2500);
	} catch (err: any) {
		error.value = err.response?.data?.errors?.[0]?.message ?? 'Could not start the scan.';
	} finally {
		running.value = false;
	}
}

async function cancelRun(runId: string) {
	try {
		await api.post(`/quality-rules/runs/${runId}/cancel`);
		await hydrate();
	} catch (err) {
		unexpectedError(err);
	}
}

async function save() {
	saving.value = true;

	try {
		await api.patch(`/quality-rules/${props.primaryKey}`, {
			...form.value,
			fields: form.value.fields
				.split(',')
				.map((field) => field.trim())
				.filter(Boolean),
			schedule: form.value.schedule || null,
		});

		editing.value = false;
		await hydrate();
	} catch (err: any) {
		error.value = err.response?.data?.errors?.[0]?.message ?? 'Could not save rule.';
	} finally {
		saving.value = false;
	}
}

async function remove() {
	if (!window.confirm('Delete this quality rule and all of its scan results?')) return;
	await api.delete(`/quality-rules/${props.primaryKey}`);
	router.push({ name: 'quality-rules-overview' });
}

watch(page, hydrate);
onMounted(hydrate);
</script>

<template>
	<PrivateView :title="rule?.name ?? 'Quality rule'" icon="fact_check">
		<template #actions>
			<VButton :loading="running" :disabled="!updateAllowed" @click="runNow">Run now</VButton>
			<VButton v-if="updateAllowed" secondary @click="editing = !editing">{{ editing ? 'Close' : 'Edit' }}</VButton>
			<VButton v-if="deleteAllowed" kind="danger" secondary @click="remove">Delete</VButton>
		</template>

		<div class="content">
			<VNotice v-if="error" type="danger">{{ error }}</VNotice>

			<p v-if="loading">Loading…</p>

			<template v-else-if="rule">
				<section class="card">
					<h2>Rule</h2>
					<div class="details">
						<span>Collection</span>
						<strong>{{ rule.collection }}</strong>
						<span>Fields</span>
						<strong>{{ rule.fields.join(', ') }}</strong>
						<span>Check</span>
						<strong>{{ rule.type }}</strong>
						<span>Schedule</span>
						<strong>{{ rule.schedule ?? 'Manual only' }}</strong>
						<span>Version</span>
						<strong>v{{ rule.version }}</strong>
					</div>
				</section>

				<section v-if="editing" class="card form">
					<h2>Configuration</h2>
					<label>
						Name
						<input v-model="form.name" />
					</label>
					<label>
						Description
						<textarea v-model="form.description" />
					</label>
					<label>
						Collection
						<input v-model="form.collection" />
					</label>
					<label>
						Fields (comma separated)
						<input v-model="form.fields" />
					</label>
					<label>
						Check
						<select v-model="form.type">
							<option value="empty">Value is empty</option>
							<option value="broken_relation">Related record is missing</option>
						</select>
					</label>
					<label>
						Schedule
						<input v-model="form.schedule" placeholder="0 6 * * *" />
					</label>
					<label>
						Status
						<select v-model="form.status">
							<option value="inactive">Inactive</option>
							<option value="active">Active</option>
						</select>
					</label>
					<VButton :loading="saving" @click="save">Save configuration</VButton>
				</section>

				<section class="card">
					<h2>Runs</h2>
					<p v-if="runs.length === 0">This rule has not been run yet.</p>
					<div v-for="run in runs" :key="run.id" class="run">
						<div>
							<strong>{{ run.status }}</strong>
							<span>
								{{ run.trigger }} · v{{ run.rule_version }} · {{ run.scanned_count }} scanned ·
								{{ run.finding_count }} findings
							</span>
							<small>{{ run.date_started }} → {{ run.date_finished ?? 'in progress' }}</small>
							<p v-if="run.error" class="error">{{ run.error }}</p>
						</div>
						<VButton
							v-if="['queued', 'running'].includes(run.status) && updateAllowed"
							small
							kind="danger"
							secondary
							@click="cancelRun(run.id)"
						>
							Cancel
						</VButton>
					</div>
				</section>

				<section class="card">
					<h2>Affected entries (latest completed scan)</h2>
					<p v-if="findings.length === 0">No accessible findings.</p>
					<table v-else>
						<thead>
							<tr>
								<th>Item</th>
								<th>Fields</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="finding in findings" :key="finding.id">
								<td>
									<RouterLink :to="`/content/${rule.collection}/${encodeURIComponent(finding.item)}`">
										{{ finding.item }}
									</RouterLink>
								</td>
								<td>{{ finding.fields.join(', ') }}</td>
							</tr>
						</tbody>
					</table>

					<div class="pager">
						<VButton :disabled="page === 1" small secondary @click="page--">Previous</VButton>
						<span>Page {{ page }} / {{ Math.max(1, Math.ceil(total / 25)) }}</span>
						<VButton :disabled="page * 25 >= total" small secondary @click="page++">Next</VButton>
					</div>
				</section>
			</template>
		</div>
	</PrivateView>
</template>

<style scoped>
.content {
	display: grid;
	gap: 1rem;
	padding: 1.5rem;
}

.card {
	display: grid;
	gap: 1rem;
	padding: 1rem;
	border: 1px solid var(--theme--border-color);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background);
}

.details {
	display: grid;
	grid-template-columns: 10rem 1fr;
	gap: 0.375rem 1rem;
}

.form {
	max-inline-size: 36rem;
}

.form label {
	display: grid;
	gap: 0.25rem;
}

.run {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	padding-block: 0.5rem;
	border-block-start: 1px solid var(--theme--border-color-subdued);
}

.run div {
	display: grid;
	gap: 0.125rem;
}

.run small,
.error {
	color: var(--theme--text-subdued);
}

.error {
	color: var(--theme--danger);
}

table {
	inline-size: 100%;
	border-collapse: collapse;
}

th,
td {
	padding: 0.5rem;
	text-align: start;
	border-block-end: 1px solid var(--theme--border-color-subdued);
}

.pager {
	display: flex;
	align-items: center;
	gap: 0.75rem;
}
</style>
