import { InvalidPayloadError } from '@directus/errors';
import type { Snapshot } from '@directus/types';
import { DiffKind } from '@directus/types';
import type { CompatibilityIssue, CompatibilityResult, MigrationPackage, MigrationPackageStepRecord } from './types.js';

export type { CompatibilityIssue, CompatibilityResult };

const sectionNames = {
	collections: 'collection',
	fields: 'field',
	relations: 'relation',
} as const;

/**
 * Compatibility check executed against the target instance before any step is
 * applied. It is read-only: the target snapshot is fetched but nothing is
 * written, so it is also used by `--dry-run`.
 */
export function checkMigrationPackage(
	pkg: MigrationPackage,
	currentSnapshot: Snapshot,
	records: MigrationPackageStepRecord[],
	options?: { allowHashMismatch?: boolean | undefined; currentHash?: string | undefined },
): CompatibilityResult {
	const issues: CompatibilityIssue[] = [];

	const completed = records.filter((record) => record.status === 'completed').map((record) => record.step);

	const completedSet = new Set(completed);
	const failedRecords = records.filter((record) => record.status === 'failed');

	// Detect bookkeeping belonging to a *different* package reusing the same id
	for (const record of records) {
		if (!pkg.steps.some((step) => step.id === record.step)) {
			issues.push({
				level: 'error',
				message:
					`Bookkeeping for package "${pkg.id}" contains unknown step "${record.step}". ` +
					`A different package with the same id may have been applied. Use a unique package id.`,
			});
		}
	}

	// Duplicate / partial execution detection
	if (completed.length > 0) {
		// Steps must be completed in order; a gap means the bookkeeping is corrupted
		for (const [index, step] of pkg.steps.entries()) {
			if (completedSet.has(step.id)) continue;

			for (const later of pkg.steps.slice(index + 1)) {
				if (completedSet.has(later.id)) {
					issues.push({
						level: 'error',
						step: later.id,
						message: `Step "${later.id}" is recorded as completed while preceding step "${step.id}" is not. Bookkeeping is inconsistent.`,
					});
				}
			}

			break;
		}

		if (failedRecords.length > 0) {
			issues.push({
				level: 'warning',
				message:
					`Package "${pkg.id}" previously failed at step "${failedRecords[0]!.step}". ` +
					`Completed steps will be skipped and the run resumes from that step.`,
			});
		} else {
			issues.push({
				level: 'warning',
				message:
					`${completed.length} of ${pkg.steps.length} steps of package "${pkg.id}" are already completed; ` +
					`they will be skipped on application.`,
			});
		}
	}

	for (const failed of failedRecords) {
		issues.push({
			level: 'warning',
			step: failed.step,
			message: `Step "${failed.step}" previously failed: ${failed.error ?? 'unknown error'}`,
		});
	}

	const currentHash = options?.currentHash;

	if (
		options?.allowHashMismatch !== true &&
		pkg.fromHash &&
		currentHash !== undefined &&
		pkg.fromHash !== currentHash &&
		// Only meaningful when nothing has been applied yet
		completed.length === 0
	) {
		issues.push({
			level: 'warning',
			message:
				`Target schema hash "${currentHash}" does not match the package's source hash "${pkg.fromHash}". ` +
				`The target instance may contain other changes. Pass --allow-hash-mismatch to silence this check.`,
		});
	}

	// Per-step conflicts against the *current* schema. Note that steps already
	// completed don't have to match the current schema anymore (their changes
	// are part of it), so they are skipped.
	for (const step of pkg.steps) {
		if (completedSet.has(step.id)) continue;

		const checkEntry = (section: 'collections' | 'fields' | 'relations') => {
			const sectionName = sectionNames[section];

			const entries = step.diff[section];

			// create-collection steps bundle their new fields; those are checked below
			if (step.kind === 'create-collection' && section === 'fields') return;

			for (const entry of entries) {
				const firstDiff = entry.diff[0]!;

				let label = entry.collection;

				if ('field' in entry) {
					const relatedCollection =
						'related_collection' in entry && entry.related_collection ? ` → ${entry.related_collection}` : '';

					label = `${entry.collection}.${entry.field}${relatedCollection}`;
				}

				// Nested meta changes surface as NEW/DELETE diffs but act on existing entities
				const isNestedMetaChange =
					section === 'fields' &&
					(firstDiff.kind === DiffKind.NEW || firstDiff.kind === DiffKind.DELETE) &&
					firstDiff.path?.[0] === 'meta';

				let exists: boolean;

				if (section === 'collections') {
					exists = currentSnapshot.collections.some((c) => c.collection === entry.collection);
				} else if (section === 'fields') {
					const fieldEntry = entry as { collection: string; field: string };

					exists = currentSnapshot.fields.some(
						(f) => f.collection === fieldEntry.collection && f.field === fieldEntry.field,
					);
				} else {
					const relationEntry = entry as { collection: string; field: string };

					exists = currentSnapshot.relations.some(
						(r) => r.collection === relationEntry.collection && r.field === relationEntry.field,
					);
				}

				if (firstDiff.kind === DiffKind.NEW && !isNestedMetaChange) {
					if (exists) {
						issues.push({
							level: 'error',
							step: step.id,
							message: `Step "${step.id}" tries to create ${sectionName} "${label}" but it already exists. Regenerate the package or resolve the conflict.`,
						});
					}
				} else if (
					firstDiff.kind === DiffKind.DELETE ||
					firstDiff.kind === DiffKind.EDIT ||
					firstDiff.kind === DiffKind.ARRAY ||
					isNestedMetaChange
				) {
					if (!exists) {
						const action = firstDiff.kind === DiffKind.DELETE && !isNestedMetaChange ? 'delete' : 'update';

						issues.push({
							level: 'error',
							step: step.id,
							message: `Step "${step.id}" tries to ${action} ${sectionName} "${label}" but it does not exist.`,
						});
					}
				}
			}
		};

		checkEntry('collections');
		checkEntry('fields');
		checkEntry('relations');

		// create-collection steps bundle their new fields; verify none of those
		// fields already exists on the target either.
		if (step.kind === 'create-collection') {
			for (const { collection, field } of step.diff.fields) {
				const exists = currentSnapshot.fields.some((f) => f.collection === collection && f.field === field);

				if (exists) {
					issues.push({
						level: 'error',
						step: step.id,
						message: `Step "${step.id}" creates collection "${step.collection}" but field "${collection}.${field}" already exists.`,
					});
				}
			}
		}

		// System field edits target fields of system collections, which must exist
		for (const { collection, field } of step.diff.systemFields) {
			const exists = currentSnapshot.systemFields.some((f) => f.collection === collection && f.field === field);

			if (!exists) {
				issues.push({
					level: 'error',
					step: step.id,
					message: `Step "${step.id}" tries to update system field "${collection}.${field}" but it does not exist in the target snapshot.`,
				});
			}
		}
	}

	const errors = issues.filter((issue) => issue.level === 'error');

	if (errors.length > 0) {
		throw new InvalidPayloadError({
			reason: `Migration package "${pkg.id}" is incompatible with the target instance:\n${errors
				.map((issue) => ` - ${issue.message}`)
				.join('\n')}`,
		});
	}

	const pending = pkg.steps.filter((step) => !completedSet.has(step.id)).map((step) => step.id);

	return {
		issues,
		completed,
		pending,
		resumable: completed.length > 0 && pending.length > 0,
	};
}
