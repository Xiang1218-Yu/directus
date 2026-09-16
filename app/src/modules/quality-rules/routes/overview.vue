<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/api';
import VButton from '@/components/v-button.vue';
import VNotice from '@/components/v-notice.vue';
import { usePermissionsStore } from '@/stores/permissions';
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

const router = useRouter();
const permissionsStore = usePermissionsStore();

const rules = ref<QualityRule[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const formActive = ref(false);
const saving = ref(false);

const form = ref({
	name: '',
	description: '',
	collection: '',
	fields: '',
	type: 'empty',
	schedule: '',
	status: 'inactive',
});

const createAllowed = computed(() => permissionsStore.hasPermission('directus_quality_rules', 'create'));

async function hydrate() {
	loading.value = true;
	error.value = null;

	try {
		const response = await api.get('/quality-rules', {
			params: { fields: ['*'], sort: ['name'], limit: -1 },
		});

		rules.value = response.data.data;
	} catch {
		error.value = 'Could not load quality rules.';
	} finally {
		loading.value = false;
	}
}

async function createRule() {
	if (saving.value) return;
	saving.value = true;

	try {
		const { data } = await api.post('/quality-rules', {
			...form.value,
			fields: form.value.fields
				.split(',')
				.map((field) => field.trim())
				.filter(Boolean),
			schedule: form.value.schedule || null,
		});

		formActive.value = false;
		router.push({ name: 'quality-rule', params: { primaryKey: data.data.id } });
	} catch (err: any) {
		error.value = err.response?.data?.errors?.[0]?.message ?? 'Could not create quality rule.';
	} finally {
		saving.value = false;
	}
}

onMounted(hydrate);
</script>

<template>
	<PrivateView title="Quality Checks" icon="fact_check">
		<template #actions>
			<VButton v-if="createAllowed" @click="formActive = true">Create rule</VButton>
		</template>

		<div class="grid">
			<VNotice v-if="error" type="danger">{{ error }}</VNotice>

			<section class="rules">
				<p v-if="loading">Loading…</p>
				<p v-else-if="rules.length === 0">No quality rules yet.</p>

				<button
					v-for="rule in rules"
					:key="rule.id"
					class="rule"
					type="button"
					@click="router.push({ name: 'quality-rule', params: { primaryKey: rule.id } })"
				>
					<span class="rule-name">{{ rule.name }}</span>
					<span class="rule-meta">{{ rule.type }} · {{ rule.collection }} · v{{ rule.version }}</span>
					<span class="rule-status">{{ rule.status }}</span>
				</button>
			</section>
		</div>

		<div v-if="formActive" class="dialog-backdrop" @click.self="formActive = false">
			<form class="dialog" @submit.prevent="createRule">
				<h2>Create quality rule</h2>

				<label>
					Name
					<input v-model="form.name" required />
				</label>

				<label>
					Collection
					<input v-model="form.collection" placeholder="articles" required />
				</label>

				<label>
					Fields (comma separated)
					<input v-model="form.fields" placeholder="title,seo.image" required />
				</label>

				<label>
					Check
					<select v-model="form.type">
						<option value="empty">Value is empty</option>
						<option value="broken_relation">Related record is missing</option>
					</select>
				</label>

				<label>
					Schedule (cron, optional)
					<input v-model="form.schedule" placeholder="0 6 * * *" />
				</label>

				<label>
					Status
					<select v-model="form.status">
						<option value="inactive">Inactive</option>
						<option value="active">Active</option>
					</select>
				</label>

				<div class="dialog-actions">
					<VButton type="button" secondary @click="formActive = false">Cancel</VButton>
					<VButton type="submit" :loading="saving">Create</VButton>
				</div>
			</form>
		</div>
	</PrivateView>
</template>

<style scoped>
.grid {
	display: grid;
	gap: 1rem;
	padding: 1.5rem;
}

.rule {
	display: grid;
	grid-template-columns: 1fr auto auto;
	gap: 1rem;
	inline-size: 100%;
	align-items: center;
	padding: 0.875rem 1rem;
	border: 1px solid var(--theme--border-color);
	border-radius: var(--theme--border-radius);
	background: var(--theme--background);
	text-align: start;
	cursor: pointer;
}

.rule-meta,
.rule-status {
	color: var(--theme--text-subdued);
	font-size: 0.875rem;
}

.dialog-backdrop {
	position: fixed;
	inset: 0;
	display: grid;
	place-items: center;
	background: rgb(0 0 0 / 0.45);
	z-index: 100;
}

.dialog {
	display: grid;
	gap: 0.875rem;
	inline-size: min(34rem, calc(100vw - 2rem));
	padding: 1.25rem;
	background: var(--theme--background);
	border-radius: var(--theme--border-radius);
}

.dialog label,
.dialog input,
.dialog select {
	display: grid;
	gap: 0.25rem;
}

.dialog-actions {
	display: flex;
	justify-content: flex-end;
	gap: 0.5rem;
}
</style>
