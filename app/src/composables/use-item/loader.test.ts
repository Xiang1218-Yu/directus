import { isSystemCollection } from '@directus/system-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { useItemLoader } from './loader';
import sdk from '@/sdk';

const { requestHandlers } = vi.hoisted(() => ({ requestHandlers: [] as { path?: string }[] }));

vi.mock('@/sdk', async () => {
	const { mockSdk } = await import('@/test-utils/sdk');
	return mockSdk((options) => {
		const { path, method, body } = options as Record<string, any>;
		requestHandlers.push(options as Record<string, any>);

		if (path === '/items/articles/1') return Promise.resolve({ id: 1, title: 'Main item' });
		if (path === '/items/articles') return Promise.resolve({ id: 42, title: 'Singleton' });
		if (path === 'versions/v1') return Promise.resolve({ delta: { title: 'Draft only' } });
		if (path === '/roles/1') return Promise.resolve({ id: 1, name: 'Administrator' });
		if (method === 'SEARCH') return Promise.resolve(body?.query ?? []);

		return Promise.resolve({});
	});
});

vi.mock('@directus/system-data', () => ({
	isSystemCollection: vi.fn(() => false),
}));

vi.mock('@/utils/translate-object-values', () => ({
	translate: vi.fn((response) => ({ ...response, translated: true })),
}));

function setup(overrides: Partial<Parameters<typeof useItemLoader>[0]> = {}) {
	const collection = ref('articles');
	const primaryKey = ref<any>(1);

	const api = useItemLoader({
		collection,
		primaryKey,
		isSingleton: computed(() => false),
		isItemlessVersion: computed(() => false),
		currentVersion: ref(null),
		query: ref({ fields: ['*'] }),
		...overrides,
	});

	return { collection, primaryKey, ...api };
}

beforeEach(() => {
	requestHandlers.length = 0;
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(isSystemCollection).mockReturnValue(false);
});

describe('useItemLoader', () => {
	it('requests the item endpoint with the read query and exposes the response', async () => {
		const { item, loadingItem, getItem } = setup();
		await getItem();

		expect(requestHandlers[0]).toEqual({
			path: '/items/articles/1',
			params: { fields: ['*'] },
		});

		expect(item.value).toEqual({ id: 1, title: 'Main item' });
		expect(loadingItem.value).toBe(false);
	});

	it('targets the collection endpoint without id for singletons', async () => {
		const { getItem } = setup({
			primaryKey: ref(null),
			isSingleton: computed(() => true),
		});

		await getItem();

		expect(requestHandlers[0]?.path).toBe('/items/articles');
	});

	it('loads the version delta for itemless versions', async () => {
		const { item, getItem } = setup({
			isItemlessVersion: computed(() => true),
			currentVersion: ref({ id: 'v1' } as any),
		});

		await getItem();

		expect(requestHandlers[0]).toEqual({ path: 'versions/v1' });
		expect(item.value).toEqual({ title: 'Draft only' });
	});

	it('captures request failures in error without throwing and resets the loading flag', async () => {
		const failure = new Error('network');
		vi.spyOn(sdk, 'request').mockRejectedValue(failure);

		const { error, loadingItem, getItem } = setup();
		await getItem();

		expect(error.value).toBe(failure);
		expect(loadingItem.value).toBe(false);
	});

	it('clears a previous error on the next successful load', async () => {
		const handler = vi
			.fn<(...args: any[]) => Promise<any>>()
			.mockRejectedValueOnce(new Error('network'))
			.mockResolvedValueOnce({ id: 1, title: 'Recovered' });

		vi.spyOn(sdk, 'request').mockImplementation(handler as any);

		const { error, item, getItem } = setup();
		await getItem();
		expect(error.value?.message).toBe('network');

		await getItem({ silent: true });
		expect(error.value).toBe(null);
		expect(item.value).toEqual({ id: 1, title: 'Recovered' });
	});

	it('silent loads leave the loading flag untouched for the outside form', async () => {
		const { loadingItem, getItem } = setup();
		const promise = getItem({ silent: true });
		expect(loadingItem.value).toBe(false);
		await promise;
		expect(loadingItem.value).toBe(false);
	});

	it('translates system collection responses', async () => {
		vi.mocked(isSystemCollection).mockReturnValue(true);

		const { item, getItem } = setup({ collection: ref('directus_roles') });
		await getItem();

		expect(item.value).toMatchObject({ id: 1, translated: true });
	});
});
