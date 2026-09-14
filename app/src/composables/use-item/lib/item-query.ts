import type { Query } from '@directus/types';
import { isEqual } from 'lodash';
import { computed, ComputedRef, MaybeRef, Ref, unref } from 'vue';
import type { ContentVersionMaybeNew } from '@/types/versions';

/**
 * Builds the read query for an item. Version context is the only implicit concern here: an active
 * version adds `version`/`versionRaw`, a not-yet-created version (`id === '+'`) behaves like no
 * version until the first save creates it.
 */
export function buildItemQuery(
	currentVersion: Ref<ContentVersionMaybeNew | null> | null,
	extraQuery: MaybeRef<Omit<Query, 'version' | 'versionRaw'>> = {},
): ComputedRef<Query> {
	return computed<Query>((prev) => {
		const version = unref(currentVersion);
		const extra = unref(extraQuery);

		const next: Query =
			!version || version.id === '+' ? { ...extra } : { ...extra, version: version.key, versionRaw: true };

		// Preserve reference on equivalent shapes; otherwise the auto-switch to a new ('+') draft would refetch and disable form fields mid-edit.
		return prev && isEqual(prev, next) ? prev : next;
	});
}
