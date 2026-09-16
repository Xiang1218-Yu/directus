import { flushPromises, shallowMount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import ImpactReportPanel from './impact-report-panel.vue';

const mockRequest = vi.hoisted(() => vi.fn());
const isAdmin = vi.hoisted(() => vi.fn(() => true));

vi.mock('@directus/sdk', () => ({
	readDeploymentImpactReports: vi.fn((query) => ({ query })),
	createDeploymentImpactReport: vi.fn((options) => ({ options })),
	retryDeploymentImpactReport: vi.fn((id) => ({ id })),
}));

vi.mock('@/sdk', () => ({
	sdk: { request: mockRequest },
}));

vi.mock('@/stores/user', () => ({
	useUserStore: () => ({ isAdmin: isAdmin() }),
}));

vi.mock('@/stores/permissions', () => ({
	usePermissionsStore: () => ({ hasPermission: vi.fn(() => true) }),
}));

vi.mock('vue-i18n', () => ({
	useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/utils/unexpected-error', () => ({ unexpectedError: vi.fn() }));

const global = {
	stubs: {
		'v-button': defineComponent({
			props: {
				icon: { type: String, default: undefined },
				loading: { type: Boolean, default: false },
				small: { type: Boolean, default: false },
			},
			emits: ['click'],
			setup: (_, { slots, emit }) => () =>
				h('button', { 'data-test': 'button', onClick: () => emit('click') }, slots.default?.()),
		}),
		VIcon: true,
		VInfo: defineComponent({
			props: {
				icon: { type: String, default: undefined },
				title: { type: String, required: true },
				type: { type: String, default: 'info' },
			},
			setup: (_, { slots }) => () => h('section', [h('h2', 'info'), slots.default?.()]),
		}),
		VProgressCircular: true,
	},
};

function mountPanel(props = {}) {
	return shallowMount(ImpactReportPanel, {
		props,
		global: {
			...global,
			config: {
				globalProperties: {
					$t: (key: string) => key,
				},
			},
		},
	});
}

describe('ImpactReportPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isAdmin.mockReturnValue(true);
	});

	it('shows a dedicated state when the provider has not been configured', () => {
		const wrapper = mountPanel({ providerConfigured: false });

		expect(wrapper.text()).toContain('deployment.impact_report.provider_unconfigured');
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('shows an empty state and generation control when no reports exist', async () => {
		mockRequest.mockResolvedValueOnce([]);
		const wrapper = mountPanel();
		await flushPromises();

		expect(wrapper.text()).toContain('deployment.impact_report.empty');
		expect(wrapper.findAll('[data-test="button"]').length).toBeGreaterThan(0);
	});

	it('shows generating state for pending reports and polls the list', async () => {
		vi.useFakeTimers();

		mockRequest.mockResolvedValue([
			{
				id: 'report-1',
				deployment: null,
				deployment_run: null,
				status: 'processing',
				attempts: 1,
				error: null,
				expires_at: null,
				started_at: null,
				completed_at: null,
				date_created: new Date().toISOString(),
				result: null,
			},
		]);

		const wrapper = mountPanel();
		await flushPromises();
		expect(wrapper.text()).toContain('deployment.impact_report.generating');

		await vi.advanceTimersByTimeAsync(3000);
		expect(mockRequest).toHaveBeenCalledTimes(2);

		wrapper.unmount();
		vi.useRealTimers();
	});

	it('shows no-changes interaction for a completed report without impact', async () => {
		mockRequest.mockResolvedValueOnce([
			{
				id: 'report-1',
				deployment: null,
				deployment_run: null,
				status: 'completed',
				attempts: 1,
				error: null,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
				started_at: null,
				completed_at: new Date().toISOString(),
				date_created: new Date().toISOString(),
				result: {
					summary: { collections: 0, fields: 0, relations: 0, permissions: 0, pending_migrations: 0 },
					collections: [],
					fields: [],
					permissions: [],
					pending_migrations: [],
				},
			},
		]);

		const wrapper = mountPanel();
		await flushPromises();

		expect(wrapper.text()).toContain('deployment.impact_report.no_changes');
	});

	it('offers retry for failed reports', async () => {
		mockRequest.mockResolvedValueOnce([
			{
				id: 'report-1',
				deployment: null,
				deployment_run: null,
				status: 'failed',
				attempts: 3,
				error: 'boom',
				expires_at: null,
				started_at: null,
				completed_at: new Date().toISOString(),
				date_created: new Date().toISOString(),
				result: null,
			},
		]);

		mockRequest.mockResolvedValueOnce({ id: 'report-1', status: 'pending' });

		const wrapper = mountPanel();
		await flushPromises();
		await wrapper.findAll('[data-test="button"]').find((button) => button.text().includes('retry'))!.trigger('click');
		await flushPromises();

		expect(mockRequest).toHaveBeenCalledTimes(2);
	});
});
