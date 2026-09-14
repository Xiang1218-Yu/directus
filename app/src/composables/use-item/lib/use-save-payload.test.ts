import { Field } from '@directus/types';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useSavePayload } from './use-save-payload';
import { validateItem } from '@/utils/validate-item';

vi.mock('@/utils/validate-item', () => ({
	validateItem: vi.fn(() => []),
}));

vi.mock('@/utils/clear-hidden-fields-by-condition', () => ({
	clearHiddenFieldsByCondition: vi.fn((edits) => ({ cleared: true, ...edits })),
}));

const fields = ref<Field[]>([{ field: 'title', schema: { default_value: 'Untitled' } } as Field]);

function setup() {
	const item = ref<Record<string, any> | null>({ id: 1 });
	const edits = ref<Record<string, any>>({});
	const api = useSavePayload({ fields, item, edits, isNew: ref(false) });
	return { item, edits, ...api };
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn }));
	vi.mocked(validateItem).mockReturnValue([]);
});

describe('useSavePayload', () => {
	it('collects default values from the permitted fields', () => {
		const { defaultValues } = setup();
		expect(defaultValues.value).toEqual({ title: 'Untitled' });
	});

	it('prepareEdits runs hidden-condition clearing before the save', () => {
		const { prepareEdits, edits } = setup();
		edits.value = { title: 'Hi' };

		expect(prepareEdits()).toEqual({ cleared: true, title: 'Hi' });
	});

	it('validates the merged defaults/item/edits payload', () => {
		const { validate, edits } = setup();
		edits.value = { title: 'Edited' };

		expect(validate(edits.value)).toEqual([]);

		expect(vi.mocked(validateItem).mock.calls[0]?.[0]).toEqual({
			title: 'Edited',
			id: 1,
		});
	});

	it('appends extra (nested) errors to the returned list', () => {
		vi.mocked(validateItem).mockReturnValue([{ field: 'title' }] as any);
		const { validate } = setup();
		const errors = validate({}, [{ field: 'o2m' }]);
		expect(errors).toEqual([{ field: 'title' }, { field: 'o2m' }]);
	});

	it('validateForVersion evaluates conditions against the version', () => {
		const version = { id: 'v1', key: 'draft' };
		const { validateForVersion, edits } = setup();
		edits.value = { title: 'In a version' };

		validateForVersion(version as any);

		expect(vi.mocked(validateItem)).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'In a version' }),
			expect.any(Array),
			false,
			false,
			version,
		);
	});
});
