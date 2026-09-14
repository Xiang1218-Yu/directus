import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useVersionGoneHandler } from './use-version-gone-handler';
import { unexpectedError } from '@/utils/unexpected-error';

vi.mock('@/utils/unexpected-error', () => ({
	unexpectedError: vi.fn((_error: unknown, opts?: { dismissAction?: () => void }) => {
		lastOptions = opts ?? null;
	}),
}));

let lastOptions: { dismissAction?: () => void } | null = null;

const push = vi.fn();

function setup(isItemless = false) {
	const edits = ref<Record<string, any>>({ title: 'unsaved' });
	const isItemlessVersion = ref(isItemless);
	const setCurrentVersion = vi.fn();
	const refresh = vi.fn();

	const handleVersionGone = useVersionGoneHandler({
		edits,
		isItemlessVersion,
		setCurrentVersion,
		refresh,
		router: { push } as any,
		collectionRoute: ref('/content/articles'),
	});

	return { edits, setCurrentVersion, refresh, handleVersionGone };
}

afterEach(() => {
	vi.clearAllMocks();
	lastOptions = null;
});

describe('useVersionGoneHandler', () => {
	it('ignores errors without the versionGone marker', () => {
		const { handleVersionGone } = setup();

		expect(handleVersionGone(new Error('boom'))).toBe(false);
		expect(unexpectedError).not.toHaveBeenCalled();
	});

	it('surfaces versionGone errors with a dismiss action and signals it handled the error', () => {
		const { handleVersionGone } = setup();

		const result = handleVersionGone(Object.assign(new Error('gone'), { versionGone: true }));

		expect(result).toBe(true);
		expect(unexpectedError).toHaveBeenCalledOnce();
		expect(lastOptions?.dismissAction).toBeTypeOf('function');
	});

	it('dismissing clears edits, drops the version and reloads the main item', () => {
		const s = setup(false);
		s.handleVersionGone(Object.assign(new Error('gone'), { versionGone: true }));

		lastOptions!.dismissAction!();

		expect(s.edits.value).toEqual({});
		expect(s.setCurrentVersion).toHaveBeenCalledWith(null);
		expect(s.refresh).toHaveBeenCalledOnce();
		expect(push).not.toHaveBeenCalled();
	});

	it('dismissing an itemless version clears edits and navigates to the collection', () => {
		const s = setup(true);
		s.handleVersionGone(Object.assign(new Error('gone'), { versionGone: true }));

		lastOptions!.dismissAction!();

		expect(push).toHaveBeenCalledWith('/content/articles');
		expect(s.refresh).not.toHaveBeenCalled();
	});
});
