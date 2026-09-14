import { useCollection } from '@directus/composables';
import type { Item, PrimaryKey } from '@directus/types';
import { computed, type Ref, ref, watch } from 'vue';

/**
 * Resolves the effective primary key of an item route.
 *
 * Regular items use the route param directly. Singletons are special: their endpoint has no id and
 * the item may not exist yet (server returns `{ [pk]: null }`), so the resolved key flips between
 * `null` (not loaded), the real id, and `'+'` (not yet created).
 *
 * The resolved key is needed before the item itself is loaded (it drives the versions query), so
 * state is created synchronously and the item watcher is attached later via {@link bindItem}.
 */
export function useResolvePrimaryKey(options: {
	collection: Ref<string>;
	primaryKeyParam: Ref<PrimaryKey | null>;
	isSingleton: Ref<boolean>;
}) {
	const { collection, primaryKeyParam, isSingleton } = options;

	const { primaryKeyField } = useCollection(collection);

	/**
	 * Collection Item PK: ID or '+' (new item).
	 * Singleton Item PK: ID or '+' (new item) or `null` (not-yet loaded).
	 */
	const resolvedPrimaryKey = ref<PrimaryKey | null>(primaryKeyParam.value);
	const existingPrimaryKey = computed(() => (resolvedPrimaryKey.value === '+' ? null : resolvedPrimaryKey.value));

	// Reset on collection change to avoid previous singleton's primary key leaking into the next
	// collection's queries.
	watch(collection, () => {
		resolvedPrimaryKey.value = primaryKeyParam.value;
	});

	return { primaryKeyParam, resolvedPrimaryKey, existingPrimaryKey, resolvePrimaryKey, bindItem };

	function bindItem(item: Ref<Item | null>) {
		watch(
			[item, isSingleton, primaryKeyParam],
			([newItem, newIsSingleton, newPrimaryKeyParam]) =>
				resolvePrimaryKey(newItem, newIsSingleton as boolean, newPrimaryKeyParam as PrimaryKey | null),
			{ immediate: true },
		);
	}

	function resolvePrimaryKey(newItem: Item | null, newIsSingleton: boolean, newPrimaryKeyParam: PrimaryKey | null) {
		if (newIsSingleton) {
			if (!newItem) return;
			// Note: After fetching a singleton item, `newItem` will be `{ id: null }` if it hasn't been created yet.

			const pkField = primaryKeyField.value?.field;
			resolvedPrimaryKey.value = (pkField ? (newItem[pkField] ?? '+') : '+') as PrimaryKey;
			return;
		}

		resolvedPrimaryKey.value = newPrimaryKeyParam;
	}
}
