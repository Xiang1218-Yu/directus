import type { SnapshotDiff } from '@directus/types';
import { DiffKind } from '@directus/types';
import { describe, expect, test } from 'vitest';
import { buildMigrationPackage, buildMigrationPackageSteps } from './build-package.js';
import { validateMigrationPackage } from './validate-package.js';

type CollectionEntry = SnapshotDiff['collections'][number];
type FieldEntry = SnapshotDiff['fields'][number];
type RelationEntry = SnapshotDiff['relations'][number];

const newCollection = (collection: string, group?: string): CollectionEntry =>
	({
		collection,
		diff: [{ kind: DiffKind.NEW, rhs: { collection, meta: group ? { group } : {}, schema: { name: collection } } }],
	}) as unknown as CollectionEntry;

const editCollection = (collection: string): CollectionEntry =>
	({
		collection,
		diff: [{ kind: DiffKind.EDIT, path: ['meta', 'hidden'], lhs: false, rhs: true }],
	}) as unknown as CollectionEntry;

const deleteCollection = (collection: string): CollectionEntry =>
	({
		collection,
		diff: [{ kind: DiffKind.DELETE, lhs: { collection } }],
	}) as unknown as CollectionEntry;

const newField = (collection: string, field: string): FieldEntry =>
	({
		collection,
		field,
		diff: [{ kind: DiffKind.NEW, rhs: { field, collection, type: 'string', meta: {}, schema: {} } }],
	}) as unknown as FieldEntry;

const editField = (collection: string, field: string): FieldEntry =>
	({
		collection,
		field,
		diff: [{ kind: DiffKind.EDIT, path: ['meta', 'hidden'], lhs: false, rhs: true }],
	}) as unknown as FieldEntry;

const deleteField = (collection: string, field: string): FieldEntry =>
	({
		collection,
		field,
		diff: [{ kind: DiffKind.DELETE, lhs: { field, collection } }],
	}) as unknown as FieldEntry;

const newRelation = (collection: string, field: string, related_collection: string | null): RelationEntry =>
	({
		collection,
		field,
		related_collection,
		diff: [{ kind: DiffKind.NEW, rhs: { collection, field, meta: {}, related_collection } }],
	}) as unknown as RelationEntry;

const deleteRelation = (collection: string, field: string, related_collection: string | null): RelationEntry =>
	({
		collection,
		field,
		related_collection,
		diff: [{ kind: DiffKind.DELETE, lhs: { collection, field } }],
	}) as unknown as RelationEntry;

function diff(partial: Partial<SnapshotDiff>): SnapshotDiff {
	return {
		collections: partial.collections ?? [],
		fields: partial.fields ?? [],
		systemFields: partial.systemFields ?? [],
		relations: partial.relations ?? [],
	};
}

describe('buildMigrationPackageSteps', () => {
	test('orders phases: create collections, delete collections, update collections, fields, relations', () => {
		const steps = buildMigrationPackageSteps(
			diff({
				collections: [editCollection('articles'), deleteCollection('legacy'), newCollection('posts')],
				fields: [newField('articles', 'subtitle'), editField('articles', 'title'), deleteField('articles', 'old')],
				relations: [deleteRelation('articles', 'old_rel', 'legacy'), newRelation('posts', 'author', 'users')],
			}),
		);

		const kinds = steps.map((step) => step.kind);

		expect(kinds).toEqual([
			'create-collection',
			'delete-collection',
			'update-collection',
			'create-field',
			'update-field',
			'delete-field',
			'create-relation',
			'delete-relation',
		]);
	});

	test('creates parent collections before nested groups', () => {
		const steps = buildMigrationPackageSteps(
			diff({
				collections: [newCollection('child', 'parent'), newCollection('grandchild', 'child'), newCollection('parent')],
			}),
		);

		expect(steps.map((step) => step.collection)).toEqual(['parent', 'child', 'grandchild']);
	});

	test('bundles new fields of a new collection into the create-collection step', () => {
		const steps = buildMigrationPackageSteps(
			diff({
				collections: [newCollection('posts')],
				fields: [newField('posts', 'id'), newField('posts', 'title'), editField('users', 'name')],
			}),
		);

		const createStep = steps.find((step) => step.kind === 'create-collection' && step.collection === 'posts')!;
		expect(createStep.diff.fields).toHaveLength(2);

		// The standalone field on an existing collection remains its own step
		expect(steps.some((step) => step.kind === 'create-field' && step.collection === 'posts')).toBe(false);
		expect(steps.some((step) => step.kind === 'update-field' && step.collection === 'users')).toBe(true);
	});

	test('drops relations owned by deleted fields', () => {
		const steps = buildMigrationPackageSteps(
			diff({
				fields: [deleteField('posts', 'author_id')],
				relations: [deleteRelation('posts', 'author_id', 'users')],
			}),
		);

		expect(steps.some((step) => step.kind === 'delete-relation')).toBe(false);
		expect(steps.some((step) => step.kind === 'delete-field')).toBe(true);
	});

	test('assigns gap-free ordered numeric step ids', () => {
		const steps = buildMigrationPackageSteps(
			diff({ collections: [newCollection('b'), newCollection('a')], fields: [newField('a', 'x')] }),
		);

		const prefixes = steps.map((step) => step.id.slice(0, 4));
		expect(prefixes).toEqual(steps.map((_, index) => String(index + 1).padStart(4, '0')));
	});

	test('each step diff contains exactly one section entry', () => {
		const steps = buildMigrationPackageSteps(
			diff({
				collections: [newCollection('posts')],
				fields: [newField('posts', 'id'), newField('users', 'nickname'), editField('users', 'name')],
				relations: [newRelation('posts', 'author', 'users')],
			}),
		);

		for (const step of steps) {
			const entries =
				step.diff.collections.length +
				step.diff.fields.length +
				step.diff.systemFields.length +
				step.diff.relations.length;

			// create-collection bundles its own new fields, so 1 collection + N fields is allowed
			if (step.kind === 'create-collection') {
				expect(step.diff.collections).toHaveLength(1);
			} else {
				expect(entries).toBe(1);
			}
		}
	});

	test('a NEW field diff that only adds meta becomes a single update-field step', () => {
		// Physical column already exists; only the meta sub-object is added
		const metaOnlyField = {
			collection: 'posts',
			field: 'legacy_col',
			diff: [
				{
					kind: DiffKind.NEW,
					path: ['meta'],
					rhs: {
						id: 42,
						collection: 'posts',
						field: 'legacy_col',
						special: null,
						interface: 'input',
					},
				},
			],
		};

		const steps = buildMigrationPackageSteps(diff({ fields: [metaOnlyField as unknown as FieldEntry] }));

		expect(steps).toHaveLength(1);
		expect(steps[0]!.kind).toBe('update-field');
		expect(steps[0]!.collection).toBe('posts');
		expect(steps[0]!.field).toBe('legacy_col');
	});

	test('a top-level NEW field diff remains a create-field step', () => {
		const steps = buildMigrationPackageSteps(diff({ fields: [newField('posts', 'brand_new')] }));

		expect(steps).toHaveLength(1);
		expect(steps[0]!.kind).toBe('create-field');
	});
});

describe('buildMigrationPackage + validateMigrationPackage roundtrip', () => {
	test('produces a package that passes validation', () => {
		const pkg = buildMigrationPackage(
			diff({ collections: [newCollection('posts')], fields: [newField('posts', 'id')] }),
			{
				id: 'test-001',
				metadata: { author: 'ci', description: 'add posts' },
			},
		);

		expect(() => validateMigrationPackage(pkg)).not.toThrow();
		expect(pkg.id).toBe('test-001');
		expect(pkg.metadata.author).toBe('ci');
		expect(pkg.kind).toBe('directus.schema-migration-package');
	});

	test('rejects duplicate step ids', () => {
		const pkg = buildMigrationPackage(diff({ collections: [newCollection('posts')] }), { id: 'x' });
		pkg.steps.push(structuredClone(pkg.steps[0]!));

		expect(() => validateMigrationPackage(pkg)).toThrow(/duplicate step id/);
	});

	test('rejects unknown kind/version and malformed ids', () => {
		const pkg = buildMigrationPackage(diff({ collections: [newCollection('posts')] }), { id: 'x' });

		expect(() => validateMigrationPackage({ ...pkg, kind: 'something-else' })).toThrow();
		expect(() => validateMigrationPackage({ ...pkg, version: 99 })).toThrow();
		expect(() => validateMigrationPackage({ ...pkg, id: 'bad id!' })).toThrow();
	});

	test('rejects steps whose kind does not match the diff entry', () => {
		const pkg = buildMigrationPackage(
			diff({
				collections: [newCollection('posts')],
				fields: [newField('users', 'nickname')],
			}),
			{ id: 'x' },
		);

		// Flip the create-field step to delete-field
		const fieldStep = pkg.steps.find((step) => step.kind === 'create-field')!;
		fieldStep.kind = 'delete-field';

		expect(() => validateMigrationPackage(pkg)).toThrow(/incompatible with diff kind/);
	});

	test('accepts an empty package (no steps)', () => {
		const pkg = buildMigrationPackage(diff({}), { id: 'empty-001' });
		expect(() => validateMigrationPackage(pkg)).not.toThrow();
		expect(pkg.steps).toHaveLength(0);
	});
});
