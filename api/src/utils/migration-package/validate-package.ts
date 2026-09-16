import { InvalidPayloadError } from '@directus/errors';
import type { SnapshotDiff } from '@directus/types';
import { DiffKind } from '@directus/types';
import Joi from 'joi';
import {
	MIGRATION_PACKAGE_KIND,
	MIGRATION_PACKAGE_VERSION,
	type MigrationPackage,
	type MigrationPackageStep,
	type MigrationPackageStepKind,
} from './types.js';

const deepDiffSchema = Joi.object({
	kind: Joi.string()
		.valid(...Object.values(DiffKind))
		.required(),
	path: Joi.array().items(Joi.alternatives().try(Joi.string(), Joi.number())),
	lhs: Joi.any().when('kind', { is: [DiffKind.NEW, DiffKind.ARRAY], then: Joi.optional(), otherwise: Joi.required() }),
	rhs: Joi.any().when('kind', {
		is: [DiffKind.DELETE, DiffKind.ARRAY],
		then: Joi.optional(),
		otherwise: Joi.required(),
	}),
	index: Joi.number().when('kind', { is: DiffKind.ARRAY, then: Joi.required() }),
	item: Joi.link('#deepdiff').when('kind', { is: DiffKind.ARRAY, then: Joi.required() }),
}).id('deepdiff');

const diffSchema = Joi.object({
	collections: Joi.array()
		.items(Joi.object({ collection: Joi.string().required(), diff: Joi.array().items(deepDiffSchema).required() }))
		.required(),
	fields: Joi.array()
		.items(
			Joi.object({
				collection: Joi.string().required(),
				field: Joi.string().required(),
				diff: Joi.array().items(deepDiffSchema).required(),
			}),
		)
		.required(),
	systemFields: Joi.array()
		.items(
			Joi.object({
				collection: Joi.string().required(),
				field: Joi.string().required(),
				diff: Joi.array().items(deepDiffSchema).required(),
			}),
		)
		.required(),
	relations: Joi.array()
		.items(
			Joi.object({
				collection: Joi.string().required(),
				field: Joi.string().required(),
				related_collection: Joi.string().allow(null),
				diff: Joi.array().items(deepDiffSchema).required(),
			}),
		)
		.required(),
});

const stepKindSchema = Joi.string().valid(
	'create-collection',
	'update-collection',
	'delete-collection',
	'create-field',
	'update-field',
	'delete-field',
	'update-system-field',
	'create-relation',
	'update-relation',
	'delete-relation',
);

const stepSchema = Joi.object({
	id: Joi.string().min(1).required(),
	name: Joi.string().min(1).required(),
	kind: stepKindSchema.required(),
	collection: Joi.string().min(1).required(),
	field: Joi.string(),
	related_collection: Joi.string().allow(null),
	diff: diffSchema.required(),
});

const packageJoiSchema = Joi.object({
	kind: Joi.valid(MIGRATION_PACKAGE_KIND).required(),
	version: Joi.valid(MIGRATION_PACKAGE_VERSION).required(),
	id: Joi.string()
		.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
		.min(1)
		.max(255)
		.required(),
	metadata: Joi.object({
		createdAt: Joi.string().isoDate().required(),
		author: Joi.string().allow(''),
		description: Joi.string().allow(''),
	})
		.unknown(false)
		.required(),
	from: Joi.object({
		version: Joi.number().required(),
		directus: Joi.string().required(),
		vendor: Joi.string(),
	}).required(),
	to: Joi.object({
		version: Joi.number().required(),
		directus: Joi.string().required(),
		vendor: Joi.string(),
	}).required(),
	fromHash: Joi.string(),
	toHash: Joi.string(),
	steps: Joi.array().items(stepSchema).min(0).required(),
	rollback: Joi.array().items(stepSchema).min(0),
});

/** Value type of the {@link DiffKind} const object ('N' | 'D' | 'E' | 'A'). */
type DiffKindValue = (typeof DiffKind)[keyof typeof DiffKind];

/** Primary diff kind(s) allowed for each step kind. */
const stepKindsByKind: Record<MigrationPackageStepKind, DiffKindValue[]> = {
	'create-collection': [DiffKind.NEW],
	'delete-collection': [DiffKind.DELETE],
	'update-collection': [DiffKind.EDIT, DiffKind.ARRAY],
	'create-field': [DiffKind.NEW],
	'delete-field': [DiffKind.DELETE],
	// update-field also covers nested meta additions/removals (NEW/DELETE under meta.*)
	'update-field': [DiffKind.NEW, DiffKind.DELETE, DiffKind.EDIT, DiffKind.ARRAY],
	'update-system-field': [DiffKind.EDIT, DiffKind.ARRAY],
	'create-relation': [DiffKind.NEW],
	'delete-relation': [DiffKind.DELETE],
	'update-relation': [DiffKind.EDIT, DiffKind.ARRAY],
};

/** Section each non-create-collection step kind must live in. */
const sectionByKind: Record<MigrationPackageStepKind, 'collections' | 'fields' | 'systemFields' | 'relations'> = {
	'create-collection': 'collections',
	'delete-collection': 'collections',
	'update-collection': 'collections',
	'create-field': 'fields',
	'delete-field': 'fields',
	'update-field': 'fields',
	'update-system-field': 'systemFields',
	'create-relation': 'relations',
	'delete-relation': 'relations',
	'update-relation': 'relations',
};

/** Cross-checks a step's declared kind against the contents of its diff. */
function validateStepShape(step: MigrationPackageStep): void {
	const { collections, fields, systemFields, relations } = step.diff;

	// create-collection steps bundle the new collection with the new fields
	// created together with it (mirroring applyDiff's atomic creation).
	if (step.kind === 'create-collection') {
		if (collections.length !== 1 || systemFields.length > 0 || relations.length > 0) {
			throw new InvalidPayloadError({
				reason: `Migration package step "${step.id}" (create-collection) must contain exactly one collection entry and no system field or relation entries`,
			});
		}

		const collectionEntry = collections[0]!;

		if (collectionEntry.diff[0]?.kind !== DiffKind.NEW) {
			throw new InvalidPayloadError({
				reason: `Migration package step "${step.id}" create-collection must contain a NEW collection diff`,
			});
		}

		if (collectionEntry.collection !== step.collection || step.field !== undefined) {
			throw new InvalidPayloadError({
				reason: `Migration package step "${step.id}" target does not match its collection diff entry`,
			});
		}

		for (const fieldEntry of fields) {
			if (fieldEntry.collection !== step.collection || fieldEntry.diff[0]?.kind !== DiffKind.NEW) {
				throw new InvalidPayloadError({
					reason: `Migration package step "${step.id}" may only bundle NEW fields of collection "${step.collection}"`,
				});
			}
		}

		return;
	}

	// Every other step kind must contain exactly one entry, in its section
	const section = sectionByKind[step.kind];
	const entries = step.diff[section];

	const total = collections.length + fields.length + systemFields.length + relations.length;

	if (entries.length !== 1 || total !== 1) {
		throw new InvalidPayloadError({
			reason: `Migration package step "${step.id}" (${step.kind}) must contain exactly one ${section} diff entry`,
		});
	}

	const entry = entries[0]!;
	const firstDiff = entry.diff[0];

	if (!firstDiff) {
		throw new InvalidPayloadError({
			reason: `Migration package step "${step.id}" contains an empty diff`,
		});
	}

	if (entry.collection !== step.collection) {
		throw new InvalidPayloadError({
			reason: `Migration package step "${step.id}" target collection does not match its diff entry`,
		});
	}

	if ('field' in entry) {
		if (step.field !== entry.field) {
			throw new InvalidPayloadError({
				reason: `Migration package step "${step.id}" target field does not match its diff entry`,
			});
		}
	} else if (step.field !== undefined) {
		throw new InvalidPayloadError({
			reason: `Migration package step "${step.id}" declares a field but its diff does not target one`,
		});
	}

	if (section === 'relations' && step.related_collection !== relations[0]!.related_collection) {
		throw new InvalidPayloadError({
			reason: `Migration package step "${step.id}" related collection does not match its diff entry`,
		});
	}

	const allowedKinds = stepKindsByKind[step.kind];

	if (!allowedKinds.includes(firstDiff.kind)) {
		throw new InvalidPayloadError({
			reason: `Migration package step "${step.id}" kind "${step.kind}" is incompatible with diff kind "${firstDiff.kind}"`,
		});
	}

	// Nested meta additions/removals are only valid for update-field steps
	if (
		step.kind === 'update-field' &&
		(firstDiff.kind === DiffKind.NEW || firstDiff.kind === DiffKind.DELETE) &&
		firstDiff.path?.[0] !== 'meta'
	) {
		throw new InvalidPayloadError({
			reason: `Migration package step "${step.id}" update-field cannot create or delete the field itself; use create-field/delete-field`,
		});
	}

	// System fields only support is_indexed edits, matching validateApplyDiff
	if (section === 'systemFields' && firstDiff.kind === DiffKind.EDIT) {
		const pathString = firstDiff.path?.join('.') ?? '';

		if (pathString !== 'schema.is_indexed') {
			throw new InvalidPayloadError({
				reason: `Migration package step "${step.id}" alters property "${pathString}" on "${step.collection}.${step.field}" but only "schema.is_indexed" is supported for system fields`,
			});
		}
	}
}

/**
 * Validates a parsed migration package: structure (via Joi), step/diff
 * consistency and uniqueness/order invariants. Throws {@link InvalidPayloadError}
 * on the first problem found.
 */
export function validateMigrationPackage(input: unknown): asserts input is MigrationPackage {
	const pkg = input as Partial<MigrationPackage>;

	const { error } = packageJoiSchema.validate(pkg, { allowUnknown: false });
	if (error) throw new InvalidPayloadError({ reason: error.message });

	const validateStepList = (stepList: MigrationPackageStep[], label: string): void => {
		const ids = new Set<string>();

		for (const [index, step] of stepList.entries()) {
			validateStepShape(step);

			if (ids.has(step.id)) {
				throw new InvalidPayloadError({
					reason: `Migration package ${label} list contains a duplicate step id "${step.id}"`,
				});
			}

			ids.add(step.id);

			// Steps are applied in array order; bookkeeping relies on contiguous
			// numbering prefixes so keep ids numeric and gap-free.
			const expectedId = `${String(index + 1).padStart(4, '0')}-`;

			if (!step.id.startsWith(expectedId)) {
				throw new InvalidPayloadError({
					reason: `Migration package ${label} step at index ${index} has id "${step.id}" but expected it to start with "${expectedId}"`,
				});
			}
		}
	};

	validateStepList(pkg.steps!, 'steps');

	if (pkg.rollback) {
		validateStepList(pkg.rollback, 'rollback');
	}
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
	return (
		diff.collections.length === 0 &&
		diff.fields.length === 0 &&
		diff.systemFields.length === 0 &&
		diff.relations.length === 0
	);
}
