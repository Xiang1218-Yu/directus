import { InvalidPayloadError } from '@directus/errors';
import type { SchemaOverview } from '@directus/types';
import { describe, expect, test } from 'vitest';
import { isQualityViolation, validateQualityRuleConfiguration } from './quality-rules-lib.js';

const schema = {
	collections: {
		articles: {
			collection: 'articles',
			primary: 'id',
			fields: {
				id: { field: 'id' },
				title: { field: 'title' },
				cover: { field: 'cover' },
			},
		},
		files: {
			collection: 'files',
			primary: 'id',
			fields: { id: { field: 'id' } },
		},
	},
	relations: [
		{
			collection: 'articles',
			field: 'cover',
			related_collection: 'files',
			schema: { foreign_key_column: 'id' },
			meta: null,
		},
	],
} as unknown as SchemaOverview;

describe('isQualityViolation', () => {
	test('detects empty values', () => {
		expect(isQualityViolation('empty', null)).toBe(true);
		expect(isQualityViolation('empty', '  ')).toBe(true);
		expect(isQualityViolation('empty', [])).toBe(true);
		expect(isQualityViolation('empty', 'title')).toBe(false);
	});
});

describe('validateQualityRuleConfiguration', () => {
	test('accepts an existing field', () => {
		expect(() =>
			validateQualityRuleConfiguration('empty', schema.collections['articles']!, ['title'], schema.relations),
		).not.toThrow();
	});

	test('rejects a missing field', () => {
		expect(() =>
			validateQualityRuleConfiguration('empty', schema.collections['articles']!, ['missing'], schema.relations),
		).toThrow(InvalidPayloadError);
	});

	test('rejects a broken relation check on a non-relational field', () => {
		expect(() =>
			validateQualityRuleConfiguration('broken_relation', schema.collections['articles']!, ['title'], schema.relations),
		).toThrow(InvalidPayloadError);
	});
});
