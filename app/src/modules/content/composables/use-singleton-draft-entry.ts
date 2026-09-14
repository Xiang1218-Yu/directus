import { VERSION_KEY_DRAFT } from '@directus/constants';
import type { AppCollection, PrimaryKey } from '@directus/types';
import { type Ref, watch } from 'vue';
import type { RouteLocationNormalized, Router } from 'vue-router';

/**
 * Enters the draft context for a brand-new singleton.
 *
 * Singletons have no explicit "new" URL after creation; when a not-yet-created singleton is opened
 * (`resolvedPrimaryKey === '+'`) under a versioning-enabled collection, editing has to happen
 * through a draft version — so the route is rewritten to `?version=draft`. This is done after the
 * item loads because a synchronous route guard cannot tell an uncreated singleton from an existing
 * one.
 */
export function useSingletonDraftEntry(options: {
	isSingleton: Ref<boolean>;
	resolvedPrimaryKey: Ref<PrimaryKey | null>;
	collectionInfo: Ref<AppCollection | null>;
	route: RouteLocationNormalized;
	router: Pick<Router, 'replace'>;
}) {
	const { isSingleton, resolvedPrimaryKey, collectionInfo, route, router } = options;

	watch([isSingleton, resolvedPrimaryKey, collectionInfo], (values) => enterSingletonDraftContext(...values), {
		immediate: true,
	});

	function enterSingletonDraftContext(
		newIsSingleton: boolean,
		newResolvedPK: PrimaryKey | null,
		newCollectionInfo: AppCollection | null,
	) {
		if (!newCollectionInfo?.meta?.versioning) return;
		if (!newIsSingleton) return;
		if (route.query.version) return;
		if (newResolvedPK !== '+') return;

		router.replace({ ...route, query: { ...route.query, version: VERSION_KEY_DRAFT } });
	}
}
