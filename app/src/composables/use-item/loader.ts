import { isSystemCollection } from '@directus/system-data';
import type { Item, Query } from '@directus/types';
import { getEndpoint } from '@directus/utils';
import { computed, type ComputedRef, ref, type Ref } from 'vue';
import sdk, { requestEndpoint } from '@/sdk';
import type { ContentVersionMaybeNew } from '@/types/versions';
import { translate } from '@/utils/translate-object-values';

/**
 * Owns reading one item from the API.
 *
 * Boundary contract:
 * - `item` is the last server response, `error` the last load failure, `loadingItem` the local
 *   fetch flag (permission loading stays in the facade, combined into the public `loading`).
 * - Loads never touch the staged-edit delta and never show notifications; callers decide whether a
 *   failure is fatal.
 * - `getItem({ silent: true })` re-reads in the background (version switch, collab broadcast,
 *   external refresh) without toggling the form loading state.
 */
export function useItemLoader<T extends Item>(options: {
	collection: Ref<string>;
	primaryKey: Ref<any>;
	isSingleton: ComputedRef<boolean>;
	isItemlessVersion: ComputedRef<boolean>;
	currentVersion: Ref<ContentVersionMaybeNew | null> | null;
	query: Ref<Query>;
}) {
	const { collection, primaryKey, isSingleton, isItemlessVersion, currentVersion, query } = options;

	const item = ref<T | null>(null) as Ref<T | null>;
	const error = ref<any>(null);
	const loadingItem = ref(false);

	const itemEndpoint = computed(() => {
		if (isSingleton.value) {
			return getEndpoint(collection.value);
		}

		return `${getEndpoint(collection.value)}/${encodeURIComponent(primaryKey.value as string)}`;
	});

	async function getItem(opts?: { silent?: boolean }) {
		if (!opts?.silent) loadingItem.value = true;
		error.value = null;

		try {
			if (isItemlessVersion.value) {
				const { delta } = await sdk.request<T>(() => ({ path: `versions/${currentVersion!.value!.id}` }));
				setItemValueToResponse(delta);
				return;
			}

			const item = await sdk.request<T>(requestEndpoint(itemEndpoint.value, { params: query.value }));
			setItemValueToResponse(item);
		} catch (err) {
			error.value = err;
		} finally {
			loadingItem.value = false;
		}
	}

	function setItemValueToResponse(response: T) {
		if (
			(isSystemCollection(collection.value) && collection.value !== 'directus_collections') ||
			(collection.value === 'directus_collections' && isSystemCollection(response.collection ?? ''))
		) {
			response = translate(response);
		}

		item.value = response;
	}

	return { item, error, loadingItem, itemEndpoint, getItem, setItemValueToResponse };
}
