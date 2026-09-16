<script setup lang="ts">
import { useGroupable } from '@directus/composables';
import type { FlowRaw, FlowSessionRaw, FlowSessionStatus } from '@directus/types';
import { abbreviateNumber } from '@directus/utils';
import { computed, onMounted, ref, toRefs } from 'vue';
import { useI18n } from 'vue-i18n';
import DebugSessionDrawer from './debug-session-drawer.vue';
import DebugSessionStartDialog from './debug-session-start-dialog.vue';
import VButton from '@/components/v-button.vue';
import VIcon from '@/components/v-icon/v-icon.vue';
import VProgressLinear from '@/components/v-progress-linear.vue';
import { useFlowSessions } from '@/composables/use-flow-sessions';
import SidebarDetail from '@/views/private/components/sidebar-detail.vue';
import { useSidebarStore } from '@/views/private/private-view/stores/sidebar';

const props = defineProps<{
	flow: FlowRaw;
}>();

const { flow } = toRefs(props);

const { t } = useI18n();

const title = computed(() => t('debug_sessions'));

const { active: open } = useGroupable({
	value: title.value,
	group: 'sidebar-detail',
});

const sidebarStore = useSidebarStore();

const showInputDialog = ref(false);
const selectedSessionId = ref<string | null>(null);

const {
	sessions,
	loading,
	error,
	creating,
	actionPending,
	liveConnected,
	runningSessions,
	refresh,
	createSession,
	rerun,
	cancel,
	markStatus,
	remove,
	connectLive,
} = useFlowSessions(computed(() => flow.value.id));

const selectedSession = computed(
	() => sessions.value.find((session) => session.id === selectedSessionId.value) ?? null,
);

onMounted(() => {
	if (open.value || sidebarStore.activeAccordionItem === 'debug-sessions') {
		void refresh();
		void connectLive();
	}
});

function onToggle(isOpen: boolean) {
	if (!isOpen) return;

	void refresh();
	void connectLive();
}

async function startSession(input: unknown, name?: string) {
	const session = await createSession(input, name);
	showInputDialog.value = false;

	if (session) {
		selectedSessionId.value = session.id;
	}
}

function timeLabel(session: FlowSessionRaw): string {
	const date = new Date(session.started_at ?? session.date_created);
	return date.toLocaleString();
}

function statusIcon(status: FlowSessionStatus): string {
	switch (status) {
		case 'succeeded':
			return 'check_circle';
		case 'failed':
			return 'cancel';
		case 'cancelled':
			return 'block';
		case 'cancelling':
			return 'hourglass_top';
		default:
			return 'pending';
	}
}

function statusColor(status: FlowSessionStatus): string | undefined {
	switch (status) {
		case 'succeeded':
			return 'var(--theme--primary)';
		case 'failed':
			return 'var(--theme--danger)';
		case 'cancelled':
		case 'cancelling':
			return 'var(--theme--foreground-subdued)';
		default:
			return undefined;
	}
}
</script>

<template>
	<SidebarDetail
		id="debug-sessions"
		class="debug-sessions-detail"
		:title
		icon="bug_report"
		:badge="!loading && sessions.length > 0 ? abbreviateNumber(sessions.length) : undefined"
		@toggle="onToggle"
	>
		<div class="actions">
			<VButton small full-width :loading="creating" @click="showInputDialog = true">
				<VIcon name="play_arrow" small />
				{{ $t('start_debug_session') }}
			</VButton>
			<VIcon v-if="liveConnected" name="bolt" x-small class="live-indicator" :title="$t('live_updates_connected')" />
		</div>

		<VProgressLinear v-if="loading" indeterminate />

		<div v-else-if="error" class="state error">
			<VIcon name="error" />
			<span>{{ $t('debug_sessions_load_error') }}</span>
			<VButton small secondary @click="refresh">{{ $t('retry') }}</VButton>
		</div>

		<div v-else-if="sessions.length === 0" class="state empty">
			<VIcon name="science" />
			<p>{{ $t('no_debug_sessions') }}</p>
			<p class="hint">{{ $t('no_debug_sessions_hint') }}</p>
		</div>

		<div v-else class="sessions">
			<button
				v-for="session in sessions"
				:key="session.id"
				class="session"
				:class="{ active: selectedSessionId === session.id }"
				@click="selectedSessionId = session.id"
			>
				<VIcon :name="statusIcon(session.status)" :color="statusColor(session.status)" small />
				<span class="meta">
					<span class="name">{{ session.name || timeLabel(session) }}</span>
					<span class="sub">
						{{ $t('attempts_count', { count: session.attempts }) }} ·
						{{ $t('steps_count', { count: session.steps?.length ?? 0 }) }}
					</span>
				</span>
			</button>
		</div>

		<DebugSessionStartDialog
			v-if="showInputDialog"
			:flow="flow"
			:creating="creating"
			@start="startSession"
			@cancel="showInputDialog = false"
		/>

		<DebugSessionDrawer
			:flow="flow"
			:session="selectedSession"
			:pending="actionPending"
			:running-count="runningSessions.length"
			@close="selectedSessionId = null"
			@rerun="rerun"
			@cancel="cancel"
			@mark="markStatus"
			@delete="remove"
		/>
	</SidebarDetail>
</template>

<style lang="scss" scoped>
.actions {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	margin-block-end: 1rem;
}

.live-indicator {
	flex-shrink: 0;
	color: var(--theme--primary);
}

.v-progress-linear {
	margin: 1.375rem 0;
}

.state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 0.5rem;
	padding: 1rem 0.5rem;
	text-align: center;
	color: var(--theme--foreground-subdued);

	.v-icon {
		font-size: 1.75rem;
	}

	.hint {
		font-size: var(--font-size-1);
		font-style: italic;
	}
}

.sessions {
	display: flex;
	flex-direction: column;
	gap: 0.375rem;
}

.session {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	inline-size: 100%;
	padding: 0.375rem 0.5rem;
	text-align: start;
	border-radius: var(--theme--border-radius);

	.v-icon {
		flex-shrink: 0;
	}

	.meta {
		display: flex;
		flex-direction: column;
		min-inline-size: 0;
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.sub {
		color: var(--theme--foreground-subdued);
		font-size: var(--font-size-1);
	}

	&:hover {
		background-color: var(--theme--background-accent);
		cursor: pointer;
	}

	&.active {
		background-color: var(--theme--primary-background);
	}
}
</style>
