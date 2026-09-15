import type { SnapshotDiff } from '@directus/types';
import { DiffKind } from '@directus/types';
import chalk from 'chalk';
import { isNestedMetaUpdate } from '../../../utils/schema/apply-diff.js';

/**
 * Remove the given collections and fields from a snapshot diff
 */
export function filterSnapshotDiff(snapshot: SnapshotDiff, filters: string[]): SnapshotDiff {
	const filterSet = new Set(filters);

	function shouldKeep(item: { collection: string; field?: string }): boolean {
		if (filterSet.has(item.collection)) return false;
		if (item.field && filterSet.has(`${item.collection}.${item.field}`)) return false;
		return true;
	}

	const filteredDiff: SnapshotDiff = {
		collections: snapshot.collections.filter((item) => shouldKeep(item)),
		fields: snapshot.fields.filter((item) => shouldKeep(item)),
		systemFields: snapshot.systemFields.filter((item) => shouldKeep(item)),
		relations: snapshot.relations.filter((item) => shouldKeep(item)),
	};

	return filteredDiff;
}

/**
 * Sort a snapshot diff by collection, field and related collection, so the output is stable
 * regardless of the order of the entries in the compared snapshots
 */
export function sortSnapshotDiff(snapshotDiff: SnapshotDiff): SnapshotDiff {
	return {
		collections: [...snapshotDiff.collections].sort(compareDiffEntries),
		fields: [...snapshotDiff.fields].sort(compareDiffEntries),
		systemFields: [...snapshotDiff.systemFields].sort(compareDiffEntries),
		relations: [...snapshotDiff.relations].sort(compareDiffEntries),
	};
}

function compareDiffEntries(
	a: { collection: string; field?: string; related_collection?: string | null },
	b: { collection: string; field?: string; related_collection?: string | null },
): number {
	if (a.collection !== b.collection) return a.collection < b.collection ? -1 : 1;

	const aField = a.field ?? '';
	const bField = b.field ?? '';

	if (aField !== bField) return aField < bField ? -1 : 1;

	const aRelated = a.related_collection ?? '';
	const bRelated = b.related_collection ?? '';

	if (aRelated === bRelated) return 0;

	return aRelated < bRelated ? -1 : 1;
}

/**
 * Format a snapshot diff as human readable sections, grouped by collections, fields,
 * system fields and relations
 */
export function formatSnapshotDiffSections(snapshotDiff: SnapshotDiff): string[] {
	const sections: string[] = [];

	if (snapshotDiff.collections.length > 0) {
		const lines = [chalk.underline.bold('Collections:')];

		for (const { collection, diff } of snapshotDiff.collections) {
			if (diff[0]?.kind === DiffKind.EDIT) {
				lines.push(`  - ${chalk.magenta('Update')} ${collection}`);

				for (const change of diff) {
					if (change.kind === DiffKind.EDIT) {
						const path = formatPath(change.path!);
						lines.push(`    - Set ${path} to ${change.rhs}`);
					}
				}
			} else if (diff[0]?.kind === DiffKind.DELETE) {
				lines.push(`  - ${chalk.red('Delete')} ${collection}`);
			} else if (diff[0]?.kind === DiffKind.NEW) {
				lines.push(`  - ${chalk.green('Create')} ${collection}`);
			} else if (diff[0]?.kind === DiffKind.ARRAY) {
				lines.push(`  - ${chalk.magenta('Update')} ${collection}`);
			}
		}

		sections.push(lines.join('\n'));
	}

	if (snapshotDiff.fields.length > 0) {
		const lines = [chalk.underline.bold('Fields:')];

		for (const { collection, field, diff } of snapshotDiff.fields) {
			if (diff[0]?.kind === DiffKind.EDIT || isNestedMetaUpdate(diff[0]!)) {
				lines.push(`  - ${chalk.magenta('Update')} ${collection}.${field}`);

				for (const change of diff) {
					const path = formatPath(change.path!);

					if (change.kind === DiffKind.EDIT) {
						lines.push(`    - Set ${path} to ${change.rhs}`);
					} else if (change.kind === DiffKind.DELETE) {
						lines.push(`    - Remove ${path}`);
					} else if (change.kind === DiffKind.NEW) {
						lines.push(`    - Add ${path} and set it to ${change.rhs}`);
					}
				}
			} else if (diff[0]?.kind === DiffKind.DELETE) {
				lines.push(`  - ${chalk.red('Delete')} ${collection}.${field}`);
			} else if (diff[0]?.kind === DiffKind.NEW) {
				lines.push(`  - ${chalk.green('Create')} ${collection}.${field}`);
			} else if (diff[0]?.kind === DiffKind.ARRAY) {
				lines.push(`  - ${chalk.magenta('Update')} ${collection}.${field}`);
			}
		}

		sections.push(lines.join('\n'));
	}

	if (snapshotDiff.systemFields.length > 0) {
		const lines = [chalk.underline.bold('System Fields:')];

		for (const { collection, field, diff } of snapshotDiff.systemFields) {
			if (diff[0]?.kind === DiffKind.EDIT) {
				lines.push(`  - ${chalk.magenta('Update')} ${collection}.${field}`);

				for (const change of diff) {
					const path = formatPath(change.path!);

					if (change.kind === DiffKind.EDIT) {
						lines.push(`    - Set ${path} to ${change.rhs}`);
					} else if (change.kind === DiffKind.DELETE) {
						lines.push(`    - Remove ${path}`);
					} else if (change.kind === DiffKind.NEW) {
						lines.push(`    - Add ${path} and set it to ${change.rhs}`);
					}
				}
			}
		}

		sections.push(lines.join('\n'));
	}

	if (snapshotDiff.relations.length > 0) {
		const lines = [chalk.underline.bold('Relations:')];

		for (const { collection, field, related_collection, diff } of snapshotDiff.relations) {
			const relatedCollection = formatRelatedCollection(related_collection);

			if (diff[0]?.kind === DiffKind.EDIT) {
				lines.push(`  - ${chalk.magenta('Update')} ${collection}.${field}${relatedCollection}`);

				for (const change of diff) {
					if (change.kind === DiffKind.EDIT) {
						const path = formatPath(change.path!);
						lines.push(`    - Set ${path} to ${change.rhs}`);
					}
				}
			} else if (diff[0]?.kind === DiffKind.DELETE) {
				lines.push(`  - ${chalk.red('Delete')} ${collection}.${field}${relatedCollection}`);
			} else if (diff[0]?.kind === DiffKind.NEW) {
				lines.push(`  - ${chalk.green('Create')} ${collection}.${field}${relatedCollection}`);
			} else if (diff[0]?.kind === DiffKind.ARRAY) {
				lines.push(`  - ${chalk.magenta('Update')} ${collection}.${field}${relatedCollection}`);
			}
		}

		sections.push(lines.join('\n'));
	}

	return sections;
}

export function formatPath(path: any[]): string {
	if (path.length === 1) {
		return path.toString();
	}

	return path.slice(1).join('.');
}

export function formatRelatedCollection(relatedCollection: string | null): string {
	// Related collection doesn't exist for a2o relationship types
	if (relatedCollection) {
		return ` → ${relatedCollection}`;
	}

	return '';
}
