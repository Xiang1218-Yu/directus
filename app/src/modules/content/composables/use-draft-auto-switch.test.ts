import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { useDraftAutoSwitch } from './use-draft-auto-switch';

vi.mock('vue-i18n', async (importOriginal) => ({
	...(await importOriginal()),
	useI18n: () => ({ t: (key: string) => key }),
}));

const replace = vi.fn((..._args: any[]) => Promise.resolve(undefined));

function setup(overrides: Record<string, any> = {}) {
	const isNew = ref(false);
	const versioningEnabled = ref(true);
	const readVersionsAllowed = ref(true);
	const createVersionsAllowed = ref(true);
	const updateVersionsAllowed = ref(true);
	const currentVersion = ref<any>(null);
	const edits = ref<Record<string, any>>({});
	const hasEdits = ref(false);
	const versions = ref<any[]>([{ id: '+', key: 'draft', delta: null }]);

	const api = useDraftAutoSwitch({
		isNew,
		versioningEnabled,
		readVersionsAllowed,
		createVersionsAllowed,
		updateVersionsAllowed,
		currentVersion,
		hasEdits,
		versions,
		edits,
		router: { replace } as any,
		route: { query: {} } as any,
		...overrides,
	});

	return {
		isNew,
		versioningEnabled,
		readVersionsAllowed,
		createVersionsAllowed,
		updateVersionsAllowed,
		currentVersion,
		edits,
		hasEdits,
		versions,
		...api,
	};
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn }));
	replace.mockClear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('useDraftAutoSwitch', () => {
	it('reports the draft version placeholder and allows switching when create is permitted', () => {
		const { canAutoSwitchToDraft, draftVersion } = setup();

		expect(draftVersion.value?.key).toBe('draft');
		expect(canAutoSwitchToDraft.value).toBe(true);
	});

	it('stashes the first edit and navigates into the draft version', async () => {
		const s = setup();
		s.edits.value = { title: 'first edit' };
		s.hasEdits.value = true;

		await nextTick();

		expect(s.edits.value).toEqual({});
		expect(replace).toHaveBeenCalledOnce();
		expect(replace.mock.calls[0]![0].query).toEqual({ version: 'draft' });
		expect(s.applyAutoSwitchPendingEdits()).toEqual({ title: 'first edit' });
	});

	it('returns null from apply when there is no stashed edit', () => {
		const s = setup();
		expect(s.applyAutoSwitchPendingEdits()).toBe(null);
	});

	it('does not auto-switch when the draft already contains content', () => {
		const s = setup({
			versions: ref<any[]>([{ id: 'v-existing', key: 'draft', delta: { title: 'existing' } }]),
			updateVersionsAllowed: ref(false),
		});

		expect(s.canAutoSwitchToDraft.value).toBe(false);
	});

	it('requires update (existing draft) or create (new draft) permission', () => {
		const s = setup({
			createVersionsAllowed: ref(false),
			updateVersionsAllowed: ref(false),
		});

		expect(s.canAutoSwitchToDraft.value).toBe(false);

		const existingDraft = setup({
			versions: ref<any[]>([{ id: 'v-existing', key: 'draft', delta: null }]),
			createVersionsAllowed: ref(false),
			updateVersionsAllowed: ref(true),
		});

		expect(existingDraft.canAutoSwitchToDraft.value).toBe(true);
	});

	it('never auto-switches for new items, disabled versioning, or a selected version', () => {
		expect(setup({ isNew: ref(true) }).canAutoSwitchToDraft.value).toBe(false);
		expect(setup({ versioningEnabled: ref(false) }).canAutoSwitchToDraft.value).toBe(false);
		expect(setup({ currentVersion: ref({ id: 'v1', key: 'review' }) }).canAutoSwitchToDraft.value).toBe(false);
	});
});
