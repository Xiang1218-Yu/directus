import { InvalidPayloadError } from '@directus/errors';
import type { QualityRule, Relation, SchemaOverview } from '@directus/types';

type QualityCollection = SchemaOverview['collections'][string];

export function validateQualityRuleConfiguration(
	type: QualityRule['type'],
	collection: QualityCollection,
	fields: string[],
	allRelations: Relation[],
): void {
	for (const field of fields) {
		if (!collection.fields[field]) {
			throw new InvalidPayloadError({
				reason: `Field "${field}" does not exist in collection "${collection.collection}"`,
			});
		}
	}

	if (type === 'broken_relation') {
		for (const field of fields) {
			const relation = allRelations.find(
				(relation) => relation.collection === collection.collection && relation.field === field,
			);

			if (!relation?.related_collection || !relation.schema) {
				throw new InvalidPayloadError({ reason: `Field "${field}" is not a many-to-one relation` });
			}
		}
	}
}

export function isQualityViolation(type: QualityRule['type'], value: unknown): boolean {
	if (type === 'empty') {
		if (Array.isArray(value)) return value.length === 0;
		return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
	}

	return value === null || value === undefined || value === '';
}
