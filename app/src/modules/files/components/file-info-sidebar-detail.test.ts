import type { File } from '@directus/types';
import { mount } from '@vue/test-utils';
import { describe, expect, test, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import FileInfoSidebarDetail from './file-info-sidebar-detail.vue';

vi.mock('@/api', () => ({
	default: {
		get: vi.fn(),
	},
}));

vi.mock('@/composables/use-clipboard', () => ({
	useClipboard: () => ({
		copyToClipboard: vi.fn(),
	}),
}));

const i18n = createI18n({
	legacy: false,
	missingWarn: false,
	locale: 'en-US',
	messages: {
		'en-US': {
			checksum: 'Checksum',
			file_details: 'File Details',
			'date-fns_date_short': 'yyyy-MM-dd',
		},
	},
});

function makeFile(overrides: Partial<File> = {}): File {
	return {
		id: 'file-id',
		storage: 'local',
		filename_disk: 'file-id.txt',
		filename_download: 'test.txt',
		title: 'Test',
		type: 'text/plain',
		folder: null,
		created_on: '2026-01-01T00:00:00.000Z',
		uploaded_by: null,
		uploaded_on: null,
		modified_by: null,
		modified_on: '2026-01-01T00:00:00.000Z',
		charset: null,
		filesize: 100,
		width: null,
		height: null,
		duration: null,
		embed: null,
		description: null,
		location: null,
		tags: null,
		metadata: null,
		focal_point_x: null,
		focal_point_y: null,
		tus_id: null,
		tus_data: null,
		checksum: null,
		...overrides,
	};
}

function mountSidebar(file: File) {
	return mount(FileInfoSidebarDetail, {
		props: {
			file,
			isNew: false,
		},
		global: {
			plugins: [i18n],
			stubs: {
				SidebarDetail: { template: '<div><slot /></div>' },
				UserPopover: { template: '<div><slot /></div>' },
				RouterLink: { template: '<a><slot /></a>' },
				VIcon: true,
				VDivider: true,
			},
			directives: {
				tooltip: () => {},
			},
		},
	});
}

describe('file-info-sidebar-detail', () => {
	test('shows the checksum when the file has one', () => {
		const checksum = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3';

		const wrapper = mountSidebar(makeFile({ checksum }));

		expect(wrapper.text()).toContain('Checksum');
		expect(wrapper.text()).toContain(checksum);
	});

	test('hides the checksum row when the file has none', () => {
		const wrapper = mountSidebar(makeFile({ checksum: null }));

		expect(wrapper.text()).not.toContain('Checksum');
	});
});
