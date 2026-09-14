import type { Ref } from 'vue';
import type { Router } from 'vue-router';
import { unexpectedError } from '@/utils/unexpected-error';

/**
 * Handles the "version gone" save error: the version another user (or another tab) deleted while
 * this editor was open. The error is surfaced with a dismiss action that resets local state — for
 * itemless versions it leaves the collection, for regular versions it drops the version context
 * and reloads the main item.
 */
export function useVersionGoneHandler(options: {
	edits: Ref<Record<string, any>>;
	isItemlessVersion: Ref<boolean>;
	setCurrentVersion: (version: null) => void;
	refresh: () => void;
	router: Pick<Router, 'push'>;
	collectionRoute: Ref<string>;
}) {
	const { edits, isItemlessVersion, setCurrentVersion, refresh, router, collectionRoute } = options;

	return handleVersionGone;

	function handleVersionGone(error: unknown): boolean {
		if (!error || typeof error !== 'object' || !('versionGone' in error)) return false;

		unexpectedError(error, {
			dismissAction: () => {
				edits.value = {};

				if (isItemlessVersion.value) {
					router.push(collectionRoute.value);
				} else {
					setCurrentVersion(null);
					refresh();
				}
			},
		});

		return true;
	}
}
