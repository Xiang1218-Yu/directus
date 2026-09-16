import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import DebugSessionDrawer from './debug-session-drawer.vue';
import DebugSessionsSidebar from './debug-sessions-sidebar.vue';
import { i18n } from '@/lang';

const state = {
	sessions: ref<any[]>([]),
	loading: ref(false),
	error: ref<unknown>(null),
	creating: ref(false),
	actionPending: ref(false),
	liveConnected: ref(false),
	runningSessions: ref<any[]>([]),
};

const refresh = vi.hoisted(() => vi.fn());
const createSession = vi.hoisted(() => vi.fn());
const rerun = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const markStatus = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());
const connectLive = vi.hoisted(() => vi.fn());

vi.mock('@/composables/use-flow-sessions', () => ({
	useFlowSessions: () => ({
		sessions: state.sessions,
		loading: state.loading,
		error: state.error,
		creating: state.creating,
		actionPending: state.actionPending,
		liveConnected: state.liveConnected,
		runningSessions: state.runningSessions,
		refresh,
		createSession,
		rerun,
		cancel,
		markStatus,
		remove,
		connectLive,
	}),
}));

vi.mock('@directus/composables', () => ({
	useGroupable: () => ({ active: { value: false } }),
}));

vi.mock('@/views/private/private-view/stores/sidebar', () => ({
	useSidebarStore: () => ({ activeAccordionItem: null }),
}));

vi.mock('@/views/private/components/sidebar-detail.vue', () => ({
	default: defineComponent({
		name: 'SidebarDetail',
		props: ['title', 'icon', 'badge'],
		template: `
			<section class="sidebar-detail">
				<slot name="header" />
				<slot />
			</section>
		`,
	}),
}));

const flow = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Test Flow',
	operations: [
		{ id: '44444444-4444-4444-8444-444444444444', name: 'Transform', key: 'transform', type: 'transform' },
		{ id: '55555555-5555-4555-8555-555555555555', name: 'Notify', key: 'notify', type: 'notification' },
	],
} as any;

const failedSession = {
	id: '22222222-2222-4222-8222-222222222222',
	flow: flow.id,
	name: 'failed run',
	status: 'failed',
	input: { hello: 'world' },
	steps: [
		{
			operation: '44444444-4444-4444-8444-444444444444',
			key: 'transform',
			status: 'resolve',
			options: {},
			data: { ok: true },
		},
		{
			operation: '55555555-5555-4555-8555-555555555555',
			key: 'notify',
			status: 'reject',
			options: {},
			data: { message: 'boom' },
		},
	],
	error: { message: 'boom' },
	attempts: 1,
	started_operation: '44444444-4444-4444-8444-444444444444',
	started_at: new Date().toISOString(),
	heartbeat: null,
	completed_at: new Date().toISOString(),
	date_created: new Date().toISOString(),
	user_created: 'owner-user',
} as any;

const stubs = {
	VButton: defineComponent({
		name: 'VButton',
		emits: ['click'],
		template: '<button class="v-button" @click="$emit(\'click\')"><slot /></button>',
	}),
	VIcon: defineComponent({
		name: 'VIcon',
		props: ['name', 'color'],
		template: '<i :data-name="name" />',
	}),
	VProgressLinear: true,
	VDrawer: defineComponent({
		name: 'VDrawer',
		props: ['modelValue'],
		template: '<div v-if="modelValue"><slot /></div>',
	}),
	VDetail: defineComponent({
		name: 'VDetail',
		props: ['label'],
		template: '<details><summary>{{ label }}</summary><slot /></details>',
	}),
	VNotice: true,
};

function mountSidebar() {
	return mount(DebugSessionsSidebar, {
		props: { flow },
		global: {
			plugins: [i18n],
			stubs,
		},
	});
}

function mountDrawer(session: any = failedSession) {
	return mount(DebugSessionDrawer, {
		props: { flow, session, pending: false, runningCount: 0 },
		global: {
			plugins: [i18n],
			stubs,
		},
	});
}

beforeEach(() => {
	state.sessions.value = [];
	state.loading.value = false;
	state.error.value = null;
	state.creating.value = false;
	state.liveConnected.value = false;
	state.runningSessions.value = [];
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('DebugSessionsSidebar states', () => {
	it('renders the empty state when no sessions exist', () => {
		const wrapper = mountSidebar();

		expect(wrapper.text()).toContain('No debug sessions yet');
		expect(wrapper.find('.state.empty').exists()).toBe(true);
	});

	it('renders the error state with a retry button when loading fails', async () => {
		state.error.value = new Error('network down');
		const wrapper = mountSidebar();

		expect(wrapper.find('.state.error').exists()).toBe(true);

		await wrapper
			.findAll('button')
			.find((b) => b.text().includes('Retry'))!
			.trigger('click');

		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it('renders sessions with their status and opens one on click', async () => {
		state.sessions.value = [
			failedSession,
			{ ...failedSession, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'succeeded', name: 'ok run' },
		];

		const wrapper = mountSidebar();

		expect(wrapper.findAll('.session')).toHaveLength(2);
		expect(wrapper.text()).toContain('failed run');
	});
});

describe('DebugSessionDrawer failed-node rerun', () => {
	it('rerun remaining branch resumes from the last rejecting node', async () => {
		const wrapper = mountDrawer();

		const rerunButton = wrapper.findAll('button').find((b) => b.text().includes('Rerun Remaining Branch'));
		expect(rerunButton).toBeDefined();

		await rerunButton!.trigger('click');

		const events = wrapper.emitted('rerun');
		expect(events).toHaveLength(1);
		expect(events![0]).toEqual([failedSession.id, '55555555-5555-4555-8555-555555555555']);
	});

	it('rerun from trigger emits a null node', async () => {
		const wrapper = mountDrawer();

		await wrapper
			.findAll('button')
			.find((b) => b.text().includes('Rerun from Trigger'))!
			.trigger('click');

		expect(wrapper.emitted('rerun')![0]).toEqual([failedSession.id, null]);
	});

	it('exposes a per-node rerun action with the node id', async () => {
		const wrapper = mountDrawer();

		const nodeRerunButtons = wrapper.findAll('button[title="Rerun from this node"]');
		expect(nodeRerunButtons.length).toBe(failedSession.steps.length);

		await nodeRerunButtons[0]!.trigger('click');

		expect(wrapper.emitted('rerun')![0]).toEqual([failedSession.id, '44444444-4444-4444-8444-444444444444']);
	});

	it('emits the final error and shows its content', () => {
		const wrapper = mountDrawer();
		expect(wrapper.text()).toContain('boom');
	});

	it('shows cancel instead of rerun while the session is running', () => {
		const wrapper = mountDrawer({ ...failedSession, status: 'running', completed_at: null });

		expect(wrapper.findAll('button').some((b) => b.text().includes('Cancel Run'))).toBe(true);
		expect(wrapper.findAll('button').some((b) => b.text().includes('Rerun'))).toBe(false);
	});
});
