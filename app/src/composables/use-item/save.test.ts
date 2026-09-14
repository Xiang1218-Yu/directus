import { Field } from '@directus/types';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useItemSave } from './save';
import sdk from '@/sdk';
import { unexpectedError } from '@/utils/unexpected-error';
import { validateItem as validateItemMock } from '@/utils/validate-item';

vi.mock('@/utils/notify', () => ({
	notify: vi.fn(),
}));

vi.mock('@/sdk', async () => {
	const { mockSdk } = await import('@/test-utils/sdk');
	return mockSdk(() => Promise.resolve({ id: 1 }));
});

vi.mock('@/utils/validate-item', () => ({
	validateItem: vi.fn(() => []),
}));

vi.mock('@/utils/clear-hidden-fields-by-condition', () => ({
	clearHiddenFieldsByCondition: vi.fn((edits) => ({ ...edits })),
}));

vi.mock('@/utils/unexpected-error', () => ({
	unexpectedError: vi.fn(),
}));

const fields = ref<Field[]>([{ field: 'title' } as Field]);

function setup(overrides: Partial<Parameters<typeof useItemSave<any>>[0]> = {}) {
	const collection = ref('articles');
	const item = ref<Record<string, any> | null>({ id: 1 });
	const edits = ref<Record<string, any>>({});
	const nestedValidationErrors = ref<any[]>([]);

	const setItem = vi.fn((next: Record<string, any>) => {
		item.value = next;
	});

	const clearEdits = vi.fn(() => {
		edits.value = {};
	});

	const itemEndpoint = computed(() => `/items/${collection.value}/1`);

	const api = useItemSave({
		collection,
		isNew: computed(() => false),
		itemEndpoint,
		fields,
		item,
		edits,
		nestedValidationErrors,
		setItem,
		clearEdits,
		...overrides,
	});

	return { collection, item, edits, nestedValidationErrors, setItem, clearEdits, ...api };
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
});

afterEach(() => {
	vi.clearAllMocks();
	vi.mocked(validateItemMock).mockReturnValue([]);
});

describe('useItemSave', () => {
	it('PATCHes existing items against the item endpoint and clears the delta on success', async () => {
		const spy = vi.spyOn(sdk, 'request').mockResolvedValue({ id: 1, title: 'Saved' });
		const { save, edits, clearEdits } = setup();
		edits.value = { title: 'Saved' };

		const result = await save();

		expect(spy.mock.lastCall?.[0]()).toEqual({
			path: '/items/articles/1',
			method: 'PATCH',
			body: { title: 'Saved' },
		});

		expect(result).toEqual({ id: 1, title: 'Saved' });
		expect(clearEdits).toHaveBeenCalledOnce();
	});

	it('POSTs new items against the collection endpoint', async () => {
		const spy = vi.spyOn(sdk, 'request').mockResolvedValue({ id: 9 });
		const { save, edits } = setup({ isNew: computed(() => true) });
		edits.value = { title: 'New' };

		await save();

		expect(spy.mock.lastCall?.[0]()).toEqual({
			path: '/items/articles',
			method: 'POST',
			body: { title: 'New' },
		});
	});

	it('blocks the request when client validation fails and surfaces the errors', async () => {
		const spy = vi.spyOn(sdk, 'request');
		vi.mocked(validateItemMock).mockReturnValue([{ field: 'title' }] as any);

		const { save, saving, validationErrors, edits } = setup();
		edits.value = { title: '' };

		await expect(save()).rejects.toBeInstanceOf(Array);

		expect(spy).not.toHaveBeenCalled();
		expect(validationErrors.value).toEqual([{ field: 'title' }]);
		expect(saving.value).toBe(false);
	});

	it('merges nested validation errors from field interfaces into the failure list', async () => {
		const nestedError = { field: 'o2m.field' };
		vi.mocked(validateItemMock).mockReturnValue([]);

		const { save, validationErrors, nestedValidationErrors, edits } = setup();
		nestedValidationErrors.value = [nestedError];
		edits.value = { title: 'x' };

		await expect(save()).rejects.toBeInstanceOf(Array);
		expect(validationErrors.value).toEqual([nestedError]);
	});

	it('splits server validation errors from unexpected errors and rethrows the payload', async () => {
		const serverError = {
			errors: [{ extensions: { code: 'FAILED_VALIDATION', field: 'title' } }],
		};

		const spy = vi.spyOn(sdk, 'request').mockRejectedValue(serverError);
		const { save, validationErrors, edits } = setup();
		edits.value = { title: 'bad' };

		await expect(save()).rejects.toBe(serverError);
		expect(validationErrors.value).toEqual([{ code: 'FAILED_VALIDATION', field: 'title' }]);
		expect(unexpectedError).not.toHaveBeenCalled();
		expect(spy).toHaveBeenCalledOnce();
	});

	it('lets onSaveError swallow a specific error while rethrowing it', async () => {
		const special = { extensions: { code: 'LIMIT_EXCEEDED' } };
		vi.spyOn(sdk, 'request').mockRejectedValue(special);
		const onSaveError = vi.fn(() => true);

		const { save, edits } = setup({ saveOptions: { onSaveError } });
		edits.value = { title: 'x' };

		await expect(save()).rejects.toBe(special);
		expect(onSaveError).toHaveBeenCalledWith(special);
		expect(unexpectedError).not.toHaveBeenCalled();
	});

	it('routes unknown errors through the global unexpected-error handler', async () => {
		const failure = new Error('boom');
		vi.spyOn(sdk, 'request').mockRejectedValue(failure);
		const { save, edits } = setup();
		edits.value = { title: 'x' };

		await expect(save()).rejects.toBe(failure);
		expect(unexpectedError).toHaveBeenCalledWith(failure);
	});
});
