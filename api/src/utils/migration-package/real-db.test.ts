/**
 * Real-database regression test:
 * - builds a package from a genuine getSnapshotDiff (two real snapshots)
 * - applies it against a real SQLite database through applyDiff
 * - verifies the target schema is reached
 * - rolls it back and verifies the source schema is restored
 *
 * Covers the meta-only change (must stay a single update-field step).
 */
import knexFactory from 'knex';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import runMigrations from '../../database/migrations/run.js';
import installSeeds from '../../database/seeds/run.js';
import { applyDiff } from '../schema/apply-diff.js';
import { getSnapshotDiff } from '../schema/get-snapshot-diff.js';
import { getSnapshot } from '../schema/get-snapshot.js';
import { applyMigrationPackage } from './apply-package.js';
import { buildMigrationPackage } from './build-package.js';
import { parseMigrationPackage, serializeMigrationPackage } from './io.js';
import { validateMigrationPackage } from './validate-package.js';

// Minimal env required by the parts of the runtime reached during migrations.
// Set before any runtime module reads the environment.
process.env['DB_CLIENT'] = 'sqlite3';
process.env['DB_FILENAME'] = ':memory:';
process.env['SECRET'] ??= 'test-secret';
process.env['KEY'] ??= 'test-key';

const knex = knexFactory({
	client: 'sqlite3',
	connection: { filename: ':memory:' },
	useNullAsDefault: true,
});

// Runtime code lazily creates its own knex instance through getDatabase();
// route it at our in-memory database so migrations and services share state.
vi.mock('../../database/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../database/index.js')>();

	return {
		...actual,
		default: vi.fn(() => knex),
	};
});

beforeAll(async () => {
	await installSeeds(knex);
	await runMigrations(knex, 'latest');
}, 60000);

afterAll(async () => {
	await knex.destroy();
});

describe('migration package on a real sqlite database', () => {
	test('applies a real snapshot diff step by step and rolls it back', async () => {
		// 1) Source snapshot of the empty (system-only) schema
		const fromSnapshot = await getSnapshot({ database: knex });
		expect(fromSnapshot.collections).toEqual([]);

		// 2) Manually create a "posts" collection the same way the snapshot
		// target would describe it, by applying its diff first.
		const toSnapshot = {
			...fromSnapshot,
			collections: [
				{
					collection: 'posts',
					meta: {
						collection: 'posts',
						icon: null,
						note: null,
						display_template: null,
						hidden: false,
						singleton: false,
						translations: null,
						archive_field: null,
						archive_app_filter: true,
						archive_value: null,
						unarchive_value: null,
						sort_field: null,
						item_duplication_fields: null,
						sort: null,
						group: null,
						collapse: 'open',
						color: null,
					},
					schema: { name: 'posts' },
				},
			],
			fields: [
				{
					collection: 'posts',
					field: 'id',
					name: 'id',
					type: 'integer',
					meta: null,
					schema: {
						name: 'id',
						table: 'posts',
						data_type: 'INTEGER',
						default_value: null,
						max_length: null,
						numeric_precision: null,
						numeric_scale: null,
						is_nullable: false,
						is_unique: true,
						is_primary_key: true,
						is_generated: false,
						generation_expression: null,
						has_auto_increment: true,
					},
				},
				{
					collection: 'posts',
					field: 'title',
					name: 'title',
					type: 'string',
					meta: {
						id: 1,
						collection: 'posts',
						field: 'title',
						special: null,
						interface: 'input',
						options: null,
						display: null,
						display_options: null,
						readonly: false,
						hidden: false,
						sort: 1,
						width: 'full',
						group: null,
						translations: null,
						note: null,
						conditions: null,
						required: false,
						validation_message: null,
						validation_rule: null,
					},
					schema: {
						name: 'title',
						table: 'posts',
						data_type: 'varchar',
						default_value: null,
						max_length: 255,
						numeric_precision: null,
						numeric_scale: null,
						is_nullable: true,
						is_unique: false,
						is_primary_key: false,
						is_generated: false,
						generation_expression: null,
						has_auto_increment: false,
					},
				},
			],
			relations: [],
		} as unknown as typeof fromSnapshot;

		const forwardDiff = getSnapshotDiff(fromSnapshot, toSnapshot);
		expect(forwardDiff.collections).toHaveLength(1);
		expect(forwardDiff.fields.length).toBeGreaterThan(0);

		const reverseDiff = getSnapshotDiff(toSnapshot, fromSnapshot);

		// 3) Build the package (JSON artifact round-trip, as CI would store it)
		const pkg = buildMigrationPackage(forwardDiff, {
			id: 'real-db-posts',
			from: fromSnapshot,
			to: toSnapshot,
			rollbackDiff: reverseDiff,
			metadata: { author: 'regression', description: 'add posts' },
		});

		const artifact = serializeMigrationPackage(pkg, 'json');
		const parsed = parseMigrationPackage(artifact, 'package.json');
		validateMigrationPackage(parsed);

		// 4) Apply the package for real, step by step
		await applyMigrationPackage(parsed, { database: knex, direction: 'up' });

		const afterApply = await getSnapshot({ database: knex });
		expect(afterApply.collections.map((c) => c.collection)).toContain('posts');

		const appliedFields = afterApply.fields
			.filter((f) => f.collection === 'posts')
			.map((f) => f.field)
			.sort();

		// Only managed fields (with a directus_fields row) appear in snapshots;
		// the autoincrement primary key is physical but unmanaged.
		expect(appliedFields).toEqual(['title']);

		// The physical table exists
		const hasPostsTable = await knex.schema.hasTable('posts');
		expect(hasPostsTable).toBe(true);

		// Inserting a row works end to end
		await knex.insert({ title: 'hello' }).into('posts');
		expect(await knex.select('title').from('posts')).toEqual([{ title: 'hello' }]);

		// 5) Roll the package back for real
		expect(parsed.rollback?.length).toBeGreaterThan(0);

		await applyMigrationPackage(parsed, { database: knex, direction: 'down' });

		expect(await knex.schema.hasTable('posts')).toBe(false);

		const afterRollback = await getSnapshot({ database: knex });
		expect(afterRollback.collections).toEqual([]);
		expect(afterRollback.fields.filter((f) => f.collection === 'posts')).toEqual([]);

		// 6) Rollback cleared bookkeeping, so the package can be applied again
		await applyMigrationPackage(parsed, { database: knex, direction: 'up' });
		expect(await knex.schema.hasTable('posts')).toBe(true);

		// and rolled back a second time
		await applyMigrationPackage(parsed, { database: knex, direction: 'down' });
		expect(await knex.schema.hasTable('posts')).toBe(false);
	}, 60000);

	test('meta-only change on an existing managed field is a single update-field step', async () => {
		// Managed collection where the physical "label" column is registered in
		// directus_fields with only schema, but its meta row (interface etc.)
		// appears later: getSnapshotDiff then emits a nested NEW for `meta`.
		await knex.schema.createTable('widgets', (table) => {
			table.increments('id').primary();
			table.string('label', 255).nullable();
		});

		await knex.insert({ collection: 'widgets' }).into('directus_collections');

		await knex
			.insert({ collection: 'widgets', field: 'id', special: null, interface: 'input' })
			.into('directus_fields');

		try {
			const before = await getSnapshot({ database: knex });

			const labelBefore = before.fields.find((f) => f.collection === 'widgets' && f.field === 'label');
			expect(labelBefore).toBeUndefined();

			// Simulate the field becoming managed WITH full meta, as a real
			// Directus field creation would write it.
			await knex
				.insert({
					collection: 'widgets',
					field: 'label',
					special: null,
					interface: 'input',
					options: null,
					display: null,
					display_options: null,
					readonly: false,
					hidden: false,
					sort: 2,
					width: 'full',
					group: null,
					translations: null,
					note: null,
					conditions: null,
					required: false,
				})
				.into('directus_fields');

			const after = await getSnapshot({ database: knex });

			// Reproduce the original bug condition: craft a "before" snapshot
			// where label exists with meta: null but the same schema.
			const labelAfter = after.fields.find((f) => f.collection === 'widgets' && f.field === 'label')!;
			const beforeWithLabel = structuredClone(after);

			beforeWithLabel.fields = beforeWithLabel.fields.map((f) =>
				f.collection === 'widgets' && f.field === 'label' ? ({ ...f, meta: null } as typeof f) : f,
			);

			const diff = getSnapshotDiff(beforeWithLabel, after);

			const labelDiffs = diff.fields.filter((f) => f.collection === 'widgets' && f.field === 'label');
			expect(labelDiffs).toHaveLength(1);

			// Meta appearance can be expressed either as nested NEW (null → object)
			// or nested EDIT (empty meta object → populated meta object)
			const firstChange = labelDiffs[0]!.diff[0]!;
			expect(['N', 'E']).toContain(firstChange.kind);
			expect(firstChange.path?.[0]).toBe('meta');
			expect(labelAfter).toBeDefined();

			const pkg = buildMigrationPackage(diff, { id: 'real-db-meta', from: beforeWithLabel, to: after });

			const fieldSteps = pkg.steps.filter((s) => s.collection === 'widgets' && s.field === 'label');
			expect(fieldSteps).toHaveLength(1);
			expect(fieldSteps[0]!.kind).toBe('update-field');

			// Reset meta values to the "before" state, then apply the single step for real
			await knex('directus_fields').where({ collection: 'widgets', field: 'label' }).update({
				interface: null,
				options: null,
				display: null,
				display_options: null,
				width: null,
				sort: null,
				readonly: false,
				hidden: true,
				note: null,
				group: null,
				translations: null,
				conditions: null,
				required: false,
			});

			await applyDiff(beforeWithLabel, fieldSteps[0]!.diff, { database: knex });

			const withMeta = await knex
				.select('interface', 'width')
				.from('directus_fields')
				.where({ collection: 'widgets', field: 'label' });

			expect(withMeta[0]!.interface).toBe('input');
			expect(withMeta[0]!.width).toBe('full');
		} finally {
			await knex.schema.dropTableIfExists('widgets');
			await knex('directus_fields').where({ collection: 'widgets' }).del();
			await knex('directus_collections').where({ collection: 'widgets' }).del();
		}
	}, 60000);
});
