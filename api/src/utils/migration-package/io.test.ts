import { DiffKind } from '@directus/types';
import { dump as toYaml } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { buildMigrationPackage } from './build-package.js';
import { parseMigrationPackage, serializeMigrationPackage } from './io.js';

const pkg = buildMigrationPackage(
	{
		collections: [
			{
				collection: 'posts',
				diff: [{ kind: DiffKind.NEW, rhs: { collection: 'posts', meta: {}, schema: {} } }],
			},
		],
		fields: [
			{
				collection: 'posts',
				field: 'id',
				diff: [{ kind: DiffKind.NEW, rhs: { collection: 'posts', field: 'id', type: 'integer' } }],
			},
		],
		systemFields: [],
		relations: [],
	} as any,
	{ id: 'io-001', metadata: { author: 'tester' } },
);

describe('migration package io', () => {
	test('roundtrips JSON', () => {
		const serialized = serializeMigrationPackage(pkg, 'json');
		expect(serialized.trimStart().startsWith('{')).toBe(true);

		const parsed = parseMigrationPackage(serialized, 'package.json');
		expect(parsed.id).toBe('io-001');
		expect(parsed.steps).toHaveLength(pkg.steps.length);
	});

	test('roundtrips YAML when given a yaml filename', () => {
		const serialized = toYaml(pkg);
		const parsed = parseMigrationPackage(serialized, 'package.yaml');

		expect(parsed.id).toBe('io-001');
		expect(parsed.kind).toBe('directus.schema-migration-package');
		expect(parsed.steps[0]!.collection).toBe('posts');
	});

	test('parses yml extension', () => {
		const serialized = toYaml(pkg);
		const parsed = parseMigrationPackage(serialized, 'package.yml');
		expect(parsed.metadata.author).toBe('tester');
	});

	test('throws validation errors for invalid JSON content', () => {
		expect(() => parseMigrationPackage(JSON.stringify({ nope: true }), 'bad.json')).toThrow();
	});

	test('throws on invalid YAML content', () => {
		expect(() => parseMigrationPackage('kind: wrong\n', 'bad.yaml')).toThrow();
	});
});
