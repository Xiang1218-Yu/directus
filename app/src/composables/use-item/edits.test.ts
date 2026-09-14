import { describe, expect, it } from 'vitest';
import { useItemEdits } from './edits';

describe('useItemEdits', () => {
	it('starts empty and reports dirty state per key count', () => {
		const { edits, hasEdits } = useItemEdits();

		expect(edits.value).toEqual({});
		expect(hasEdits.value).toBe(false);

		edits.value.title = 'hello';
		expect(hasEdits.value).toBe(true);
	});

	it('discard resets the staged delta', () => {
		const { edits, hasEdits, discard } = useItemEdits();
		edits.value = { title: 'hello' };

		discard();

		expect(edits.value).toEqual({});
		expect(hasEdits.value).toBe(false);
	});

	it('apply merges values into the existing delta', () => {
		const { edits, apply } = useItemEdits();
		edits.value = { title: 'hello' };

		apply({ status: 'draft', title: 'world' });

		expect(edits.value).toEqual({ title: 'world', status: 'draft' });
	});

	it('clearPersistedKeys only removes keys unchanged since they were saved', () => {
		const { edits, clearPersistedKeys } = useItemEdits();
		edits.value = { title: 'saved', status: 'changed-again' };

		clearPersistedKeys({ title: 'saved', status: 'saved-older' });

		expect(edits.value).toEqual({ status: 'changed-again' });
	});
});
