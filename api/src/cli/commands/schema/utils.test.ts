import type { SnapshotDiff, SnapshotField, SnapshotRelation, SnapshotSystemField } from '@directus/types';
import type { ApiCollection } from '@directus/types';
import { DiffKind } from '@directus/types';
import type { Diff } from 'deep-diff';
import { describe, expect, test } from 'vitest';
import {
	filterSnapshotDiff,
	formatPath,
	formatRelatedCollection,
	formatSnapshotDiffSections,
	sortSnapshotDiff,
} from './utils.js';

describe('filterSnapshotDiff', () => {
	test('should filter out collections by name', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [
				{ collection: 'users', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
				{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
			],
			fields: [],
			systemFields: [],
			relations: [],
		};

		const result = filterSnapshotDiff(snapshotDiff, ['users']);

		expect(result.collections).toHaveLength(1);
		expect(result.collections[0]!.collection).toBe('posts');
	});

	test('should filter out fields by collection.field name', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [],
			fields: [
				{
					collection: 'posts',
					field: 'title',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
				{
					collection: 'posts',
					field: 'content',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
			],
			systemFields: [],
			relations: [],
		};

		const result = filterSnapshotDiff(snapshotDiff, ['posts.title']);

		expect(result.fields).toHaveLength(1);
		expect(result.fields[0]!.field).toBe('content');
	});

	test('should filter out all fields in a collection when collection is filtered', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [
				{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
			],
			fields: [
				{
					collection: 'posts',
					field: 'title',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
				{
					collection: 'posts',
					field: 'content',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
				{
					collection: 'users',
					field: 'name',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
			],
			systemFields: [],
			relations: [],
		};

		const result = filterSnapshotDiff(snapshotDiff, ['posts']);

		expect(result.collections).toHaveLength(0);
		expect(result.fields).toHaveLength(1);
		expect(result.fields[0]!.collection).toBe('users');
	});

	test('should filter system fields by collection.field', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [],
			fields: [],
			systemFields: [
				{
					collection: 'posts',
					field: 'date_created',
					diff: [{ kind: DiffKind.EDIT, lhs: {}, rhs: {} } as Diff<SnapshotSystemField | undefined>],
				},
				{
					collection: 'posts',
					field: 'date_updated',
					diff: [{ kind: DiffKind.EDIT, lhs: {}, rhs: {} } as Diff<SnapshotSystemField | undefined>],
				},
			],
			relations: [],
		};

		const result = filterSnapshotDiff(snapshotDiff, ['posts.date_created']);

		expect(result.systemFields).toHaveLength(1);
		expect(result.systemFields[0]!.field).toBe('date_updated');
	});

	test('should filter relations by collection.field', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [],
			fields: [],
			systemFields: [],
			relations: [
				{
					collection: 'posts',
					field: 'author_id',
					related_collection: 'users',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotRelation | undefined>],
				},
				{
					collection: 'posts',
					field: 'category_id',
					related_collection: 'categories',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotRelation | undefined>],
				},
			],
		};

		const result = filterSnapshotDiff(snapshotDiff, ['posts.author_id']);

		expect(result.relations).toHaveLength(1);
		expect(result.relations[0]!.field).toBe('category_id');
	});

	test('should handle multiple filters', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [
				{ collection: 'users', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
				{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
			],
			fields: [
				{
					collection: 'posts',
					field: 'title',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
				{
					collection: 'posts',
					field: 'content',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
			],
			systemFields: [],
			relations: [],
		};

		const result = filterSnapshotDiff(snapshotDiff, ['users', 'posts.title']);

		expect(result.collections).toHaveLength(1);
		expect(result.collections[0]!.collection).toBe('posts');
		expect(result.fields).toHaveLength(1);
		expect(result.fields[0]!.field).toBe('content');
	});

	test('should return all items when no filters provided', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [
				{ collection: 'users', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
			],
			fields: [
				{
					collection: 'posts',
					field: 'title',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
			],
			systemFields: [],
			relations: [],
		};

		const result = filterSnapshotDiff(snapshotDiff, []);

		expect(result.collections).toHaveLength(1);
		expect(result.fields).toHaveLength(1);
	});
});

describe('sortSnapshotDiff', () => {
	test('should sort all diff groups by collection and field', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [
				{ collection: 'users', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
				{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
			],
			fields: [
				{
					collection: 'posts',
					field: 'title',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
				{
					collection: 'posts',
					field: 'content',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
				{
					collection: 'articles',
					field: 'body',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
			],
			systemFields: [
				{
					collection: 'posts',
					field: 'date_updated',
					diff: [{ kind: DiffKind.EDIT, lhs: {}, rhs: {} } as Diff<SnapshotSystemField | undefined>],
				},
				{
					collection: 'posts',
					field: 'date_created',
					diff: [{ kind: DiffKind.EDIT, lhs: {}, rhs: {} } as Diff<SnapshotSystemField | undefined>],
				},
			],
			relations: [
				{
					collection: 'posts',
					field: 'category_id',
					related_collection: 'categories',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotRelation | undefined>],
				},
				{
					collection: 'posts',
					field: 'author_id',
					related_collection: 'users',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotRelation | undefined>],
				},
			],
		};

		const result = sortSnapshotDiff(snapshotDiff);

		expect(result.collections.map(({ collection }) => collection)).toEqual(['posts', 'users']);

		expect(result.fields.map(({ collection, field }) => `${collection}.${field}`)).toEqual([
			'articles.body',
			'posts.content',
			'posts.title',
		]);

		expect(result.systemFields.map(({ field }) => field)).toEqual(['date_created', 'date_updated']);
		expect(result.relations.map(({ field }) => field)).toEqual(['author_id', 'category_id']);
	});

	test('should not mutate the input diff', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [
				{ collection: 'users', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
				{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
			],
			fields: [],
			systemFields: [],
			relations: [],
		};

		sortSnapshotDiff(snapshotDiff);

		expect(snapshotDiff.collections.map(({ collection }) => collection)).toEqual(['users', 'posts']);
	});
});

describe('formatSnapshotDiffSections', () => {
	test('should return an empty array when there are no differences', () => {
		const result = formatSnapshotDiffSections({
			collections: [],
			fields: [],
			systemFields: [],
			relations: [],
		});

		expect(result).toEqual([]);
	});

	test('should format all diff groups', () => {
		const snapshotDiff: SnapshotDiff = {
			collections: [
				{ collection: 'posts', diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<ApiCollection | undefined>] },
				{ collection: 'users', diff: [{ kind: DiffKind.DELETE, lhs: {} } as Diff<ApiCollection | undefined>] },
			],
			fields: [
				{
					collection: 'posts',
					field: 'title',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotField | undefined>],
				},
			],
			systemFields: [
				{
					collection: 'posts',
					field: 'date_created',
					diff: [
						{
							kind: DiffKind.EDIT,
							path: ['schema', 'is_indexed'],
							lhs: false,
							rhs: true,
						} as unknown as Diff<SnapshotSystemField | undefined>,
					],
				},
			],
			relations: [
				{
					collection: 'posts',
					field: 'author_id',
					related_collection: 'users',
					diff: [{ kind: DiffKind.NEW, rhs: {} } as Diff<SnapshotRelation | undefined>],
				},
			],
		};

		const result = formatSnapshotDiffSections(snapshotDiff);

		expect(result).toHaveLength(4);
		expect(result[0]).toContain('Collections:');
		expect(result[0]).toContain('posts');
		expect(result[0]).toContain('users');
		expect(result[1]).toContain('Fields:');
		expect(result[1]).toContain('posts.title');
		expect(result[2]).toContain('System Fields:');
		expect(result[2]).toContain('posts.date_created');
		expect(result[2]).toContain('Set is_indexed to true');
		expect(result[3]).toContain('Relations:');
		expect(result[3]).toContain('posts.author_id');
		expect(result[3]).toContain('→ users');
	});
});

describe('formatPath helper', () => {
	test('should return single element as string', () => {
		const result = formatPath(['field']);
		expect(result).toBe('field');
	});

	test('should join multiple elements with dots, skipping first', () => {
		const result = formatPath(['ignored', 'meta', 'hidden']);
		expect(result).toBe('meta.hidden');
	});

	test('should handle two-element array', () => {
		const result = formatPath(['ignored', 'name']);
		expect(result).toBe('name');
	});

	test('should handle deep nested paths', () => {
		const result = formatPath(['ignored', 'meta', 'options', 'nested', 'value']);
		expect(result).toBe('meta.options.nested.value');
	});
});

describe('formatRelatedCollection helper', () => {
	test('should format related collection with arrow', () => {
		const result = formatRelatedCollection('users');
		expect(result).toBe(' → users');
	});

	test('should return empty string for null', () => {
		const result = formatRelatedCollection(null);
		expect(result).toBe('');
	});

	test('should handle empty string', () => {
		// Though unlikely in practice, empty string is falsy
		const result = formatRelatedCollection('');
		expect(result).toBe('');
	});
});
