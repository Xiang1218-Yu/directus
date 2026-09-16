import type { Snapshot } from '@directus/types';
import { DiffKind } from '@directus/types';
import { describe, expect, test } from 'vitest';
import { buildMigrationPackage } from './build-package.js';
import { checkMigrationPackage, type CompatibilityIssue } from './check-package.js';
import type { MigrationPackageStepRecord } from './types.js';

const emptySnapshot = (): Snapshot => ({
	version: 1,
	directus: '11.0.0',
	collections: [],
	fields: [],
	systemFields: [],
	relations: [],
});

const snapshotWithCollection = (collection: string): Snapshot => ({
	...emptySnapshot(),
	collections: [
		{
			collection,
			meta: { collection, group: null, hidden: false },
			schema: { name: collection },
		} as Snapshot['collections'][number],
	],
	fields: [
		{
			collection,
			field: 'id',
			type: 'integer',
			meta: { collection, field: 'id' },
			schema: { name: 'id' },
		} as Snapshot['fields'][number],
	],
});

const newCollectionDiff = (collection: string) =>
	({
		collections: [{ collection, diff: [{ kind: DiffKind.NEW, rhs: { collection, meta: {}, schema: {} } }] }],
		fields: [{ collection, field: 'id', diff: [{ kind: DiffKind.NEW, rhs: { field: 'id' } }] }],
		systemFields: [],
		relations: [],
	}) as const;

const deleteCollectionDiff = (collection: string) =>
	({
		collections: [{ collection, diff: [{ kind: DiffKind.DELETE, lhs: { collection } }] }],
		fields: [],
		systemFields: [],
		relations: [],
	}) as const;

const newFieldDiff = (collection: string, field: string) =>
	({
		collections: [],
		fields: [{ collection, field, diff: [{ kind: DiffKind.NEW, rhs: { field, collection } }] }],
		systemFields: [],
		relations: [],
	}) as const;

describe('checkMigrationPackage', () => {
	test('passes when creating a collection that does not exist', () => {
		const pkg = buildMigrationPackage(newCollectionDiff('posts') as any, { id: 'p1' });

		const result = checkMigrationPackage(pkg, emptySnapshot(), []);

		expect(result.issues.filter((issue: CompatibilityIssue) => issue.level === 'error')).toHaveLength(0);
		expect(result.pending).toEqual(pkg.steps.map((step) => step.id));
		expect(result.completed).toEqual([]);
	});

	test('fails when trying to create a collection that already exists', () => {
		const pkg = buildMigrationPackage(newCollectionDiff('posts') as any, { id: 'p1' });

		expect(() => checkMigrationPackage(pkg, snapshotWithCollection('posts'), [])).toThrow(/already exists/);
	});

	test('fails when trying to delete a collection that does not exist', () => {
		const pkg = buildMigrationPackage(deleteCollectionDiff('posts') as any, { id: 'p1' });

		expect(() => checkMigrationPackage(pkg, emptySnapshot(), [])).toThrow(/does not exist/);
	});

	test('fails when trying to create a field that already exists', () => {
		const pkg = buildMigrationPackage(newFieldDiff('posts', 'id') as any, { id: 'p1' });

		expect(() => checkMigrationPackage(pkg, snapshotWithCollection('posts'), [])).toThrow(
			/field "posts.id" but it already exists/,
		);
	});

	test('reports completed steps as skippable and only returns pending steps', () => {
		const pkg = buildMigrationPackage(newCollectionDiff('posts') as any, { id: 'p1' });

		const records: MigrationPackageStepRecord[] = [
			{
				package: 'p1',
				direction: 'up',
				step: pkg.steps[0]!.id,
				status: 'completed',
				error: null,
				timestamp: new Date(),
			},
		];

		// Target already contains the collection created by the completed step,
		// so its conflict check must be skipped.
		const result = checkMigrationPackage(pkg, snapshotWithCollection('posts'), records);

		expect(result.completed).toEqual([pkg.steps[0]!.id]);
		expect(result.pending).toEqual([]);
		expect(result.issues.some((issue) => /already completed/.test(issue.message))).toBe(true);
	});

	test('flags a previous failure as resumable', () => {
		const pkg = buildMigrationPackage(
			{
				collections: [
					{ collection: 'a', diff: [{ kind: DiffKind.NEW, rhs: { collection: 'a' } }] },
					{ collection: 'b', diff: [{ kind: DiffKind.NEW, rhs: { collection: 'b' } }] },
				],
				fields: [],
				systemFields: [],
				relations: [],
			} as any,
			{ id: 'p1' },
		);

		const records: MigrationPackageStepRecord[] = [
			{
				package: 'p1',
				direction: 'up',
				step: pkg.steps[0]!.id,
				status: 'completed',
				error: null,
				timestamp: new Date(),
			},
			{
				package: 'p1',
				direction: 'up',
				step: pkg.steps[1]!.id,
				status: 'failed',
				error: 'boom',
				timestamp: new Date(),
			},
		];

		const result = checkMigrationPackage(pkg, snapshotWithCollection('a'), records);

		expect(result.resumable).toBe(true);
		expect(result.issues.some((issue) => /previously failed at step/.test(issue.message))).toBe(true);
		expect(result.issues.some((issue) => /boom/.test(issue.message))).toBe(true);
		expect(result.pending).toEqual([pkg.steps[1]!.id]);
	});

	test('rejects bookkeeping entries that do not belong to this package', () => {
		const pkg = buildMigrationPackage(newCollectionDiff('posts') as any, { id: 'p1' });

		const records: MigrationPackageStepRecord[] = [
			{
				package: 'p1',
				direction: 'up',
				step: '9999-unknown',
				status: 'completed',
				error: null,
				timestamp: new Date(),
			},
		];

		expect(() => checkMigrationPackage(pkg, emptySnapshot(), records)).toThrow(/unknown step/);
	});

	test('warns on hash mismatch but does not error', () => {
		const pkg = buildMigrationPackage(newCollectionDiff('posts') as any, { id: 'p1', fromHash: 'aaa' });

		const result = checkMigrationPackage(pkg, emptySnapshot(), [], { currentHash: 'bbb' });
		expect(result.issues.some((issue) => /hash/.test(issue.message))).toBe(true);

		const silent = checkMigrationPackage(pkg, emptySnapshot(), [], {
			currentHash: 'bbb',
			allowHashMismatch: true,
		});

		expect(silent.issues.some((issue) => /hash/.test(issue.message))).toBe(false);
	});
});
