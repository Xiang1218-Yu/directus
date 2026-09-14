import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { buildItemQuery } from './item-query';

describe('buildItemQuery', () => {
	it('returns the extra query unchanged when no version is active', () => {
		const query = buildItemQuery(ref(null), { fields: ['*', 'role.*'] });

		expect(query.value).toEqual({ fields: ['*', 'role.*'] });
	});

	it('adds the version key params for an existing version', () => {
		const version = ref<any>({ id: 'v1', key: 'draft' });
		const query = buildItemQuery(version, { deep: { users: { _limit: 0 } } });

		expect(query.value).toEqual({
			deep: { users: { _limit: 0 } },
			version: 'draft',
			versionRaw: true,
		});
	});

	it('treats a not-yet-created version ("+") like no version until first save', () => {
		const query = buildItemQuery(ref<any>({ id: '+', key: 'draft' }), { fields: ['*'] });
		expect(query.value).toEqual({ fields: ['*'] });
	});

	it('keeps the same reference when the shape is equivalent', () => {
		const version = ref<any>({ id: 'v1', key: 'draft' });
		const extra = ref({ fields: ['*'] });
		const query = buildItemQuery(version, extra);
		const first = query.value;

		extra.value = { fields: ['*'] };
		expect(query.value).toBe(first);

		extra.value = { fields: ['name'] };
		expect(query.value).not.toBe(first);
	});
});
