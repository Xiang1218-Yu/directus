import { useCollection } from '@directus/composables';
import { Item, PrimaryKey, Query } from '@directus/types';
import { computed, ComputedRef, MaybeRef, ref, Ref, unref, watch } from 'vue';
import { useNestedValidation } from '../use-nested-validation';
import type { UsablePermissions } from '../use-permissions';
import { usePermissions } from '../use-permissions';
import { coerceArchiveValue, useItemActions } from './actions';
import { useItemEdits } from './edits';
import { buildItemQuery } from './lib/item-query';
import { useItemLoader } from './loader';
import { useItemSave, type UseItemSaveOptions } from './save';
import { useItemSaveAsCopy } from './save-as-copy';
import type { ContentVersionMaybeNew } from '@/types/versions';

export type { UseItemSaveOptions };
export { coerceArchiveValue };

/**
 * Editing state for one item.
 *
 * The facade only wires lifecycle (load on navigation, silent refetch on context change, hard
 * reset on refresh) and exposes the union of the composed boundaries:
 *
 * - {@link useItemEdits}      — staged delta and dirty state
 * - {@link useItemLoader}     — item read, load error/loading
 * - {@link useItemSave}       — validation queue + create/update + failure split
 * - {@link useItemSaveAsCopy} — duplicate flow
 * - {@link useItemActions}    — archive / delete
 * - {@link usePermissions}    — field/action permissions
 */
type UsableItem<T extends Item> = {
	edits: Ref<Item>;
	hasEdits: ComputedRef<boolean>;
	item: Ref<T | null>;
	permissions: UsablePermissions;
	error: Ref<any>;
	loading: ComputedRef<boolean>;
	saving: Ref<boolean>;
	refresh: () => void;
	refreshSignal: Ref<number>;
	save: () => Promise<T | undefined>;
	isNew: ComputedRef<boolean>;
	remove: () => Promise<void>;
	deleting: Ref<boolean>;
	archive: () => Promise<void>;
	isArchived: ComputedRef<boolean | null>;
	archiving: Ref<boolean>;
	saveAsCopy: () => Promise<PrimaryKey | null>;
	getItem: (opts?: { silent?: boolean }) => Promise<void>;
	validationErrors: Ref<any[]>;
};

export function useItem<T extends Item>(
	collection: Ref<string>,
	primaryKey: Ref<PrimaryKey | null>,
	currentVersion: Ref<ContentVersionMaybeNew | null> | null = null,
	isItemlessVersion: ComputedRef<boolean> = computed(() => false),
	extraQuery: MaybeRef<Omit<Query, 'version' | 'versionRaw'>> = {},
	saveOptions: UseItemSaveOptions = {},
): UsableItem<T> {
	const { info: collectionInfo } = useCollection(collection);
	const isNew = computed(() => primaryKey.value === '+');
	const isSingleton = computed(() => !!collectionInfo.value?.meta?.singleton);

	const isVersion = computed(() => unref(currentVersion) !== null);
	const permissions = usePermissions(collection, primaryKey, isNew, isVersion);
	const fieldsWithPermissions = permissions.itemPermissions.fields;

	const { edits, hasEdits, discard } = useItemEdits();

	const query = buildItemQuery(currentVersion, extraQuery);

	const { item, error, loadingItem, itemEndpoint, getItem, setItemValueToResponse } = useItemLoader<T>({
		collection,
		primaryKey,
		isSingleton,
		isItemlessVersion,
		currentVersion,
		query,
	});

	const refreshSignal = ref(0);

	const loading = computed(() => loadingItem.value || permissions.itemPermissions.loading.value);

	const { nestedValidationErrors } = useNestedValidation();

	const { saving, validationErrors, save, saveErrorHandler } = useItemSave<T>({
		collection,
		isNew,
		itemEndpoint,
		fields: fieldsWithPermissions,
		item,
		edits,
		nestedValidationErrors,
		setItem: setItemValueToResponse,
		clearEdits: discard,
		saveOptions,
	});

	const { saveAsCopy } = useItemSaveAsCopy({
		collection,
		primaryKey,
		collectionInfo,
		fields: fieldsWithPermissions,
		edits,
		isNew,
		validationErrors,
		saving,
		nestedValidationErrors,
		saveErrorHandler,
	});

	const { deleting, archiving, isArchived, archive, remove } = useItemActions<T>({
		collectionInfo,
		itemEndpoint,
		item,
	});

	watch([collection, primaryKey], refresh);

	watch(query, () => {
		const canRefetchSilently = item.value !== null;

		if (canRefetchSilently) getItem({ silent: true });
		else refresh();
	});

	refreshItem();

	return {
		edits,
		hasEdits,
		item,
		permissions,
		error,
		loading,
		saving,
		refresh,
		refreshSignal,
		save,
		isNew,
		remove,
		deleting,
		archive,
		isArchived,
		archiving,
		saveAsCopy,
		getItem,
		validationErrors,
	};

	function refresh() {
		error.value = null;
		validationErrors.value = [];
		loadingItem.value = false;
		saving.value = false;
		deleting.value = false;
		archiving.value = false;

		item.value = null;

		refreshSignal.value++;

		refreshItem();
		permissions.itemPermissions.refresh();
	}

	function refreshItem() {
		if (isNew.value && !isItemlessVersion.value) {
			item.value = null;
		} else {
			getItem();
		}
	}
}
