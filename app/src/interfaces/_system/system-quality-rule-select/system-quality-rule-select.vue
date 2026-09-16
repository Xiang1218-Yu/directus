<script setup lang="ts">
import { onMounted, ref } from 'vue';
import api from '@/api';
import VSelect from '@/components/v-select/v-select.vue';

const props = defineProps<{
	value: string | null;
	disabled?: boolean;
}>();

const emit = defineEmits(['input']);
const choices = ref<{ text: string; value: string }[]>([]);

onMounted(async () => {
	const { data } = await api.get('/quality-rules/panel/rules');

	choices.value = (data.data ?? []).map((rule: { id: string; name: string }) => ({
		text: rule.name,
		value: rule.id,
	}));
});
</script>

<template>
	<VSelect
		:model-value="props.value"
		:items="choices"
		:disabled="props.disabled"
		show-deselect
		@update:model-value="emit('input', $event)"
	/>
</template>
