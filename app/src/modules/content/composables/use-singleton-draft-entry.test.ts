import { flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useSingletonDraftEntry } from './use-singleton-draft-entry';

const replace = vi.fn();

function setup(opts: {
	isSingleton: boolean;
	resolvedPK: string | number | null;
	versioning: boolean;
	queryVersion?: string;
}) {
	const isSingleton = ref(opts.isSingleton);
	const resolvedPrimaryKey = ref<any>(opts.resolvedPK);
	const collectionInfo = ref<any>(opts.versioning ? { meta: { versioning: true } } : { meta: {} });
	const route: any = { query: opts.queryVersion ? { version: opts.queryVersion } : {} };

	useSingletonDraftEntry({
		isSingleton,
		resolvedPrimaryKey,
		collectionInfo,
		route,
		router: { replace } as any,
	});

	return { isSingleton, resolvedPrimaryKey, collectionInfo, route };
}

beforeEach(() => {
	replace.mockClear();
});

describe('useSingletonDraftEntry', () => {
	it('adds ?version=draft when a not-yet-created singleton of a versioned collection resolves to "+"', async () => {
		setup({ isSingleton: true, resolvedPK: '+', versioning: true });
		await flushPromises();

		expect(replace).toHaveBeenCalledOnce();
		expect(replace.mock.calls[0]![0].query).toEqual({ version: 'draft' });
	});

	it('does nothing for regular items', async () => {
		setup({ isSingleton: false, resolvedPK: '+', versioning: true });
		await flushPromises();
		expect(replace).not.toHaveBeenCalled();
	});

	it('does nothing when the singleton already exists', async () => {
		setup({ isSingleton: true, resolvedPK: 5, versioning: true });
		await flushPromises();
		expect(replace).not.toHaveBeenCalled();
	});

	it('does nothing when versioning is disabled', async () => {
		setup({ isSingleton: true, resolvedPK: '+', versioning: false });
		await flushPromises();
		expect(replace).not.toHaveBeenCalled();
	});

	it('does nothing when a version is already selected', async () => {
		setup({ isSingleton: true, resolvedPK: '+', versioning: true, queryVersion: 'review' });
		await flushPromises();
		expect(replace).not.toHaveBeenCalled();
	});
});
