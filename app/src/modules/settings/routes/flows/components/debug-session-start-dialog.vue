<script setup lang="ts">
import type { FlowRaw } from '@directus/types';
import { ref } from 'vue';
import VButton from '@/components/v-button.vue';
import VCardActions from '@/components/v-card-actions.vue';
import VCardText from '@/components/v-card-text.vue';
import VCardTitle from '@/components/v-card-title.vue';
import VCard from '@/components/v-card.vue';
import VDialog from '@/components/v-dialog.vue';
import VIcon from '@/components/v-icon/v-icon.vue';
import VNotice from '@/components/v-notice.vue';

const props = defineProps<{
	flow: FlowRaw;
	creating: boolean;
}>();

const emit = defineEmits<{
	start: [input: unknown, name?: string];
	cancel: [];
}>();

const open = ref(true);
const name = ref('');

const inputText = ref(
	JSON.stringify(
		{
			body: {
				collection: props.flow.options?.['collections']?.[0] ?? null,
				keys: [],
			},
		},
		null,
		2,
	),
);

const parseError = ref<string | null>(null);

function parseInput(): unknown | undefined {
	const raw = inputText.value.trim();

	if (raw.length === 0) return null;

	try {
		return JSON.parse(raw);
	} catch {
		parseError.value = '';
		return undefined;
	}
}

function start() {
	parseError.value = null;
	const input = parseInput();

	if (input === undefined) {
		parseError.value = 'invalid_json';
		return;
	}

	emit('start', input, name.value.trim() || undefined);
}

function close() {
	open.value = false;
	emit('cancel');
}
</script>

<template>
	<VDialog v-model="open" @esc="close" @update:model-value="(value) => !value && close()">
		<VCard>
			<VCardTitle>{{ $t('start_debug_session') }}</VCardTitle>
			<VCardText>
				<div class="field">
					<label for="debug-session-name">{{ $t('name_optional') }}</label>
					<input id="debug-session-name" v-model="name" type="text" />
				</div>

				<div class="field">
					<label for="debug-session-input">{{ $t('test_input_json') }}</label>
					<textarea
						id="debug-session-input"
						v-model="inputText"
						spellcheck="false"
						rows="14"
						@keydown.meta.enter="start"
						@keydown.ctrl.enter="start"
					></textarea>
				</div>

				<VNotice v-if="parseError" icon="error" type="danger">{{ $t('invalid_json') }}</VNotice>
				<VNotice>{{ $t('debug_input_redaction_notice') }}</VNotice>
			</VCardText>
			<VCardActions>
				<VButton secondary :disabled="creating" @click="close">{{ $t('cancel') }}</VButton>
				<VButton :loading="creating" @click="start">
					<VIcon name="play_arrow" small />
					{{ $t('run') }}
				</VButton>
			</VCardActions>
		</VCard>
	</VDialog>
</template>

<style lang="scss" scoped>
.field {
	display: flex;
	flex-direction: column;
	gap: 0.375rem;
	margin-block-end: 1rem;

	label {
		font-weight: 500;
	}

	input,
	textarea {
		inline-size: 32rem;
		max-inline-size: 100%;
		padding: 0.5rem 0.75rem;
		border: var(--theme--border-width) solid var(--theme--border-color);
		border-radius: var(--theme--border-radius);
		background-color: var(--theme--background-normal);
		color: var(--theme--foreground);
		font-family: var(--theme--font-family-monospace);
		font-size: var(--font-size-0);
	}

	textarea {
		inline-size: 100%;
		min-block-size: 12rem;
		resize: vertical;
	}
}
</style>
