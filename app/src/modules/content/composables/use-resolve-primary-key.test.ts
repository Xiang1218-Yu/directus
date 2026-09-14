import { flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useResolvePrimaryKey } from './use-resolve-primary-key';

vi.mock('@directus/composables', () => ({
	useCollection: () => ({
		primaryKeyField: computed(() => ({ field: 'id' })),
	}),
}));

function setup(isSingleton: boolean, param: string | number | null = 1) {
	const collection = ref('articles');
	const isSingletonRef = ref(isSingleton);
	const primaryKeyParam = ref<any>(param);
	const item = ref<Record<string, any> | null>(null);

	const api = useResolvePrimaryKey({
		collection,
		primaryKeyParam,
		isSingleton: isSingletonRef,
	});

	api.bindItem(item);

	return { item, ...api };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('useResolvePrimaryKey', () => {
	it('follows the route param for regular items', async () => {
		const s = setup(false, 7);
		await flushPromises();
		expect(s.resolvedPrimaryKey.value).toBe(7);
		expect(s.existingPrimaryKey.value).toBe(7);
	});

	it('treats the new-item param "+" as no existing key', async () => {
		const s = setup(false, '+');
		await flushPromises();
		expect(s.resolvedPrimaryKey.value).toBe('+');
		expect(s.existingPrimaryKey.value).toBe(null);
	});

	it('starts null for an unloaded singleton and flips to "+" when the server reports no id', async () => {
		const s = setup(true, null);
		await flushPromises();
		expect(s.resolvedPrimaryKey.value).toBe(null);

		s.item.value = { id: null };
		await flushPromises();
		expect(s.resolvedPrimaryKey.value).toBe('+');
	});

	it('resolves a created singleton to its actual id once the server returns one', async () => {
		const s = setup(true, null);
		s.item.value = { id: 42 };
		await flushPromises();
		expect(s.resolvedPrimaryKey.value).toBe(42);
		expect(s.existingPrimaryKey.value).toBe(42);
	});
});
