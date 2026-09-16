<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '@/api';
import VListItem from '@/components/v-list-item.vue';
import VList from '@/components/v-list.vue';

interface Props {
	showHeader?: boolean;
	rule?: string;
	limit?: number;
	dashboard?: string;
}

const props = withDefaults(defineProps<Props>(), {
	showHeader: false,
	rule: '',
	limit: 10,
	dashboard: '',
});

const router = useRouter();
const findings = ref<{ id: string; item: string; fields: string[]; collection?: string }[]>([]);
const error = ref<string | null>(null);

async function hydrate() {
	if (!props.rule) {
		findings.value = [];
		return;
	}

	try {
		const panelResponse = await api.get(`/quality-rules/${props.rule}/panel`);

		const { data } = await api.get(`/quality-rules/${props.rule}/findings`, {
			params: { limit: props.limit },
		});

		const collection = panelResponse.data.data?.collection;

		findings.value = (data.data ?? []).map((finding: { id: string; item: string; fields: string[] | string }) => ({
			...finding,
			fields: typeof finding.fields === 'string' ? JSON.parse(finding.fields) : finding.fields,
			collection,
		}));

		error.value = null;
	} catch {
		error.value = 'No accessible results';
		findings.value = [];
	}
}

const rows = computed(() => findings.value);

watch(() => [props.rule, props.limit], hydrate, { immediate: true });
</script>

<template>
	<div class="quality-findings-panel">
		<p v-if="!rule">Select a quality rule.</p>
		<p v-else-if="error">{{ error }}</p>
		<p v-else-if="rows.length === 0">No accessible findings.</p>

		<VList v-else>
			<VListItem
				v-for="finding in rows"
				:key="finding.id"
				clickable
				@click="router.push(`/content/${finding.collection}/${encodeURIComponent(finding.item)}`)"
			>
				<strong>{{ finding.item }}</strong>
				<span>{{ finding.fields.join(', ') }}</span>
			</VListItem>
		</VList>
	</div>
</template>

<style scoped>
.quality-findings-panel {
	padding: 0 0.6875rem 0.6875rem;
	overflow: auto;
}

.quality-findings-panel :deep(.v-list-item) {
	display: grid;
	gap: 0.125rem;
	align-items: start;
}

.quality-findings-panel span {
	color: var(--theme--text-subdued);
	font-size: 0.8125rem;
}
</style>
