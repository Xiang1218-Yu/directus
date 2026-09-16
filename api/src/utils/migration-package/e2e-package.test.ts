import { describe, expect, test } from 'vitest';
import { getSnapshotDiff } from '../schema/get-snapshot-diff.js';
import { buildMigrationPackage } from './build-package.js';
import { parseMigrationPackage, serializeMigrationPackage } from './io.js';
import { validateMigrationPackage } from './validate-package.js';

describe('end-to-end package build from real getSnapshotDiff', () => {
	test('JSON and YAML artifacts built from two snapshots validate', () => {
		const current = {
			version: 1,
			directus: '11.0.0',
			collections: [
				{ collection: 'users', meta: { collection: 'users', group: null, icon: null }, schema: { name: 'users' } },
			],
			fields: [
				{
					collection: 'users',
					field: 'id',
					type: 'integer',
					meta: { collection: 'users', field: 'id' },
					schema: { name: 'id' },
				},
				{
					collection: 'users',
					field: 'name',
					type: 'string',
					meta: { collection: 'users', field: 'name' },
					schema: { name: 'name' },
				},
			],
			systemFields: [],
			relations: [],
		};

		const target = {
			...current,
			collections: [
				...current.collections,
				{ collection: 'posts', meta: { collection: 'posts', group: null, icon: null }, schema: { name: 'posts' } },
			],
			fields: [
				...current.fields,
				{
					collection: 'posts',
					field: 'id',
					type: 'integer',
					meta: { collection: 'posts', field: 'id' },
					schema: { name: 'id' },
				},
				{
					collection: 'posts',
					field: 'title',
					type: 'string',
					meta: { collection: 'posts', field: 'title' },
					schema: { name: 'title' },
				},
				{
					collection: 'posts',
					field: 'author',
					type: 'integer',
					meta: { collection: 'posts', field: 'author' },
					schema: { name: 'author' },
				},
			],
			relations: [
				{
					collection: 'posts',
					field: 'author',
					related_collection: 'users',
					meta: { many_collection: 'posts', many_field: 'author', one_collection: 'users', one_field: null },
					schema: { table: 'posts', column: 'author' },
				},
			],
		};

		const diff = getSnapshotDiff(current as any, target as any);

		const pkg = buildMigrationPackage(diff, {
			id: 'e2e-add-posts',
			metadata: { author: 'ci', description: 'add posts with author relation' },
		});

		expect(pkg.steps.length).toBeGreaterThan(0);
		expect(pkg.steps[0]!.id.startsWith('0001-')).toBe(true);

		for (const format of ['json', 'yaml'] as const) {
			const serialized = serializeMigrationPackage(pkg, format);
			const parsed = parseMigrationPackage(serialized, `package.${format === 'json' ? 'json' : 'yaml'}`);
			expect(() => validateMigrationPackage(parsed)).not.toThrow();
			expect(parsed.id).toBe('e2e-add-posts');
			expect(parsed.steps.map((s) => s.kind)).toEqual(['create-collection', 'create-relation']);
		}
	});
});
