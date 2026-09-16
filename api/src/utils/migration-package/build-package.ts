import { createHash } from 'node:crypto';
import type { Snapshot, SnapshotDiff } from '@directus/types';
import { DiffKind } from '@directus/types';
import {
	MIGRATION_PACKAGE_KIND,
	MIGRATION_PACKAGE_VERSION,
	type MigrationPackage,
	type MigrationPackageMetadata,
	type MigrationPackageStep,
	type MigrationPackageStepKind,
} from './types.js';
import { isEmptyDiff } from './validate-package.js';

export interface BuildMigrationPackageOptions {
	id: string;
	metadata?: Partial<MigrationPackageMetadata> | undefined;
	from?: Snapshot | undefined;
	to?: Snapshot | undefined;
	fromHash?: string | undefined;
	toHash?: string | undefined;
	/**
	 * Diff reverting `to` back to `from` (as produced by `getSnapshotDiff(to, from)`).
	 * When provided the package gains reviewable, resumable rollback steps.
	 */
	rollbackDiff?: SnapshotDiff | undefined;
}

const emptyDiff = (): SnapshotDiff => ({ collections: [], fields: [], systemFields: [], relations: [] });

const stepIdPrefix = (index: number): string => String(index).padStart(4, '0');

function targetName(collection: string, field?: string, relatedCollection?: string | null): string {
	let name = collection;
	if (field) name += `.${field}`;
	if (relatedCollection) name += ` → ${relatedCollection}`;
	return name;
}

/** Normalizes an id component so step ids are safe bookkeeping keys. */
function normalizeIdPart(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}

/**
 * Orders collection-creation steps so grouped (nested) collections are created
 * after their parent group, matching the recursive creation order of applyDiff.
 */
function sortCreateCollections(steps: { step: MigrationPackageStep; group?: string }[]): MigrationPackageStep[] {
	const remaining = [...steps];
	const ordered: MigrationPackageStep[] = [];
	const created = new Set<string>();

	// Groups that are not being created in this package already exist on the
	// target instance, so treat them as satisfied from the start.
	const createdInPackage = new Set(remaining.map((entry) => entry.step.collection));

	for (const entry of remaining) {
		if (entry.group && !createdInPackage.has(entry.group)) created.add(entry.group);
	}

	let progressed = true;

	while (remaining.length > 0 && progressed) {
		progressed = false;

		for (let i = 0; i < remaining.length; i++) {
			const entry = remaining[i]!;

			if (!entry.group || created.has(entry.group)) {
				ordered.push(entry.step);
				created.add(entry.step.collection);
				remaining.splice(i, 1);
				i--;
				progressed = true;
			}
		}
	}

	// Cyclic or dangling group references: keep the rest in their original order,
	// applyDiff will surface the underlying error when applying.
	for (const entry of remaining) ordered.push(entry.step);

	return ordered;
}

interface UnnumberedStep extends Omit<MigrationPackageStep, 'id'> {
	id?: string;
}

/**
 * Splits a {@link SnapshotDiff} (as produced by `getSnapshotDiff`) into an
 * ordered list of single-purpose steps that can be applied transaction by
 * transaction.
 */
export function buildMigrationPackageSteps(diff: SnapshotDiff): MigrationPackageStep[] {
	const phases: UnnumberedStep[] = [];

	const add = (
		kind: MigrationPackageStepKind,
		collection: string,
		field: string | undefined,
		relatedCollection: string | null | undefined,
		stepDiff: SnapshotDiff,
	): void => {
		const step: UnnumberedStep = {
			name: `${kind.replace(/-/g, ' ')} ${targetName(collection, field, relatedCollection)}`,
			kind,
			collection,
			...(field !== undefined ? { field } : {}),
			...(relatedCollection !== undefined ? { related_collection: relatedCollection } : {}),
			diff: stepDiff,
		};

		phases.push(step);
	};

	const createdCollectionNames = new Set(
		diff.collections.filter(({ diff: d }) => d[0]?.kind === DiffKind.NEW).map(({ collection }) => collection),
	);

	// Phase 1: create collections. Fields that are new together with their
	// collection are bundled into the same step, mirroring applyDiff which
	// creates the primary key alongside the collection.
	const createCollectionEntries: { step: MigrationPackageStep; group?: string }[] = [];

	for (const { collection, diff: collectionDiff } of diff.collections) {
		if (collectionDiff[0]?.kind !== DiffKind.NEW) continue;

		const bundledFields = diff.fields.filter(
			(fieldDiff) => fieldDiff.collection === collection && fieldDiff.diff[0]?.kind === DiffKind.NEW,
		);

		const step: MigrationPackageStep = {
			id: `create-collection-${normalizeIdPart(collection)}`,
			name: `create collection ${collection}`,
			kind: 'create-collection',
			collection,
			diff: {
				...emptyDiff(),
				collections: [{ collection, diff: collectionDiff }],
				fields: bundledFields,
			},
		};

		const group = collectionDiff[0].rhs?.meta?.group;

		if (group) {
			createCollectionEntries.push({ step, group });
		} else {
			createCollectionEntries.push({ step });
		}
	}

	phases.push(...sortCreateCollections(createCollectionEntries));

	const bundledFieldKeys = new Set(
		diff.fields
			.filter(
				(fieldDiff) => createdCollectionNames.has(fieldDiff.collection) && fieldDiff.diff[0]?.kind === DiffKind.NEW,
			)
			.map((fieldDiff) => `${fieldDiff.collection}.${fieldDiff.field}`),
	);

	// Phase 2: delete collections (relations on the live schema are removed by
	// applyDiff during the same step/transaction).
	for (const { collection, diff: collectionDiff } of diff.collections) {
		if (collectionDiff[0]?.kind !== DiffKind.DELETE) continue;

		add('delete-collection', collection, undefined, undefined, {
			...emptyDiff(),
			collections: [{ collection, diff: collectionDiff }],
		});
	}

	// Phase 3: update collections
	for (const { collection, diff: collectionDiff } of diff.collections) {
		if (collectionDiff[0]?.kind !== DiffKind.EDIT && collectionDiff[0]?.kind !== DiffKind.ARRAY) continue;

		add('update-collection', collection, undefined, undefined, {
			...emptyDiff(),
			collections: [{ collection, diff: collectionDiff }],
		});
	}

	// Phase 4: fields (create, then update, then delete — same order as applyDiff).
	// Each field produces exactly one step: a NEW diff whose path starts at
	// `meta` is a meta-only change on an existing physical column and is an
	// update, not a create.
	const standaloneFields = diff.fields.filter(
		(fieldDiff) => !bundledFieldKeys.has(`${fieldDiff.collection}.${fieldDiff.field}`),
	);

	const isMetaOnlyChange = (fieldDiff: SnapshotDiff['fields'][number]['diff']): boolean => {
		const first = fieldDiff[0];
		return !!first && (first.kind === DiffKind.NEW || first.kind === DiffKind.DELETE) && first.path?.[0] === 'meta';
	};

	const createdFieldKeys = new Set<string>();

	for (const { collection, field, diff: fieldDiff } of standaloneFields) {
		if (fieldDiff[0]?.kind !== DiffKind.NEW || isMetaOnlyChange(fieldDiff)) continue;

		createdFieldKeys.add(`${collection}.${field}`);

		add('create-field', collection, field, undefined, {
			...emptyDiff(),
			fields: [{ collection, field, diff: fieldDiff }],
		});
	}

	// Update = explicit edits/array changes plus nested meta additions/removals
	for (const { collection, field, diff: fieldDiff } of standaloneFields) {
		const first = fieldDiff[0];
		const isEditLike = first?.kind === DiffKind.EDIT || first?.kind === DiffKind.ARRAY;
		const isMetaChange = isMetaOnlyChange(fieldDiff);

		if (!isEditLike && !isMetaChange) continue;

		// A field can only ever appear once in getSnapshotDiff output, but guard
		// against packages built from hand-merged diffs to keep one step per field
		if (createdFieldKeys.has(`${collection}.${field}`)) continue;

		add('update-field', collection, field, undefined, {
			...emptyDiff(),
			fields: [{ collection, field, diff: fieldDiff }],
		});
	}

	for (const { collection, field, diff: fieldDiff } of standaloneFields) {
		const first = fieldDiff[0];
		if (first?.kind !== DiffKind.DELETE || first.path?.[0] === 'meta') continue;

		add('delete-field', collection, field, undefined, {
			...emptyDiff(),
			fields: [{ collection, field, diff: fieldDiff }],
		});
	}

	// Phase 5: system field edits
	for (const { collection, field, diff: fieldDiff } of diff.systemFields) {
		if (fieldDiff[0]?.kind !== DiffKind.EDIT && fieldDiff[0]?.kind !== DiffKind.ARRAY) continue;

		add('update-system-field', collection, field, undefined, {
			...emptyDiff(),
			systemFields: [{ collection, field, diff: fieldDiff }],
		});
	}

	// Phase 6: relations (create, update, delete). Relations owned by deleted
	// fields are removed together with the field and are skipped.
	const relations = diff.relations.filter((relationDiff) => {
		const ownedByDeletedField = standaloneFields.some(
			(fieldDiff) =>
				fieldDiff.collection === relationDiff.collection &&
				fieldDiff.field === relationDiff.field &&
				fieldDiff.diff[0]?.kind === DiffKind.DELETE &&
				fieldDiff.diff[0]?.path?.[0] !== 'meta',
		);

		return !ownedByDeletedField;
	});

	for (const { collection, field, related_collection, diff: relationDiff } of relations) {
		if (relationDiff[0]?.kind !== DiffKind.NEW) continue;

		add('create-relation', collection, field, related_collection, {
			...emptyDiff(),
			relations: [{ collection, field, related_collection, diff: relationDiff }],
		});
	}

	for (const { collection, field, related_collection, diff: relationDiff } of relations) {
		if (relationDiff[0]?.kind !== DiffKind.EDIT && relationDiff[0]?.kind !== DiffKind.ARRAY) continue;

		add('update-relation', collection, field, related_collection, {
			...emptyDiff(),
			relations: [{ collection, field, related_collection, diff: relationDiff }],
		});
	}

	for (const { collection, field, related_collection, diff: relationDiff } of relations) {
		if (relationDiff[0]?.kind !== DiffKind.DELETE) continue;

		add('delete-relation', collection, field, related_collection, {
			...emptyDiff(),
			relations: [{ collection, field, related_collection, diff: relationDiff }],
		});
	}

	// Assign gap-free, ordered ids last. The numeric prefix is the bookkeeping
	// ordering key; the suffix describes the step and is capped to keep the id
	// within identifier length limits.
	return phases.map((step, index) => ({
		...step,
		id: `${stepIdPrefix(index + 1)}-${normalizeIdPart(step.id ?? `${step.kind}-${step.collection}`)}`.slice(0, 255),
	}));
}

/** Builds a validated, ordered migration package from a snapshot diff. */
export function buildMigrationPackage(diff: SnapshotDiff, options: BuildMigrationPackageOptions): MigrationPackage {
	const steps = buildMigrationPackageSteps(diff);

	const rollback = options.rollbackDiff ? buildMigrationPackageSteps(options.rollbackDiff) : undefined;

	const pkg: MigrationPackage = {
		kind: MIGRATION_PACKAGE_KIND,
		version: MIGRATION_PACKAGE_VERSION,
		id: options.id,
		metadata: {
			createdAt: options.metadata?.createdAt ?? new Date().toISOString(),
			...(options.metadata?.author ? { author: options.metadata.author } : {}),
			...(options.metadata?.description ? { description: options.metadata.description } : {}),
		},
		from: {
			version: options.from?.version ?? 0,
			directus: options.from?.directus ?? 'unknown',
			...(options.from?.vendor ? { vendor: options.from.vendor } : {}),
		},
		to: {
			version: options.to?.version ?? 0,
			directus: options.to?.directus ?? 'unknown',
			...(options.to?.vendor ? { vendor: options.to.vendor } : {}),
		},
		...(options.fromHash ? { fromHash: options.fromHash } : {}),
		...(options.toHash ? { toHash: options.toHash } : {}),
		steps,
		...(rollback && rollback.length > 0 ? { rollback } : {}),
	};

	return pkg;
}

/** Deterministic content hash used to detect tampering with a package file. */
export function getMigrationPackageHash(pkg: MigrationPackage): string {
	return createHash('sha256').update(JSON.stringify(pkg.steps)).digest('hex');
}

export { isEmptyDiff };
