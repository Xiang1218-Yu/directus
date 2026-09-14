import type { Item } from '@directus/types';
import { computed, type ComputedRef, ref, type Ref } from 'vue';
import { i18n } from '@/lang';
import sdk, { requestEndpoint } from '@/sdk';
import { notify } from '@/utils/notify';
import { unexpectedError } from '@/utils/unexpected-error';

export function coerceArchiveValue(value: string | null): string | boolean | null {
	if (value === 'true') return true;
	if (value === 'false') return false;
	return value;
}

/**
 * Owns archive/unarchive and delete of the loaded item. Both mutate the server state and then
 * reconcile local state (`item` for archive, `null` for delete) and emit one notification; the
 * REST requests (PATCH with the archive field, DELETE) stay unchanged.
 */
export function useItemActions<T extends Item>(options: {
	collectionInfo: Ref<any>;
	itemEndpoint: ComputedRef<string>;
	item: Ref<T | null>;
}) {
	const { collectionInfo, itemEndpoint, item } = options;

	const deleting = ref(false);
	const archiving = ref(false);

	const isArchived = computed(() => {
		if (!collectionInfo.value?.meta?.archive_field) return null;

		const { archive_field, archive_value } = collectionInfo.value.meta;

		return item.value?.[archive_field] === coerceArchiveValue(archive_value);
	});

	async function archive() {
		if (!collectionInfo.value?.meta?.archive_field) return;

		archiving.value = true;

		const field = collectionInfo.value.meta.archive_field;
		const archiveValue = coerceArchiveValue(collectionInfo.value.meta.archive_value);
		const unarchiveValue = coerceArchiveValue(collectionInfo.value.meta.unarchive_value);

		try {
			const value = item.value && item.value[field] === archiveValue ? unarchiveValue : archiveValue;

			await sdk.request(
				requestEndpoint(itemEndpoint.value, {
					method: 'PATCH',
					body: {
						[field]: value,
					},
				}),
			);

			item.value = {
				...(item.value as T),
				[field]: value,
			};

			notify({
				title:
					value === archiveValue ? i18n.global.t('item_delete_success', 1) : i18n.global.t('item_update_success', 1),
			});
		} catch (error) {
			unexpectedError(error);
			throw error;
		} finally {
			archiving.value = false;
		}
	}

	async function remove() {
		deleting.value = true;

		try {
			await sdk.request(requestEndpoint(itemEndpoint.value, { method: 'DELETE' }));

			item.value = null;

			notify({ title: i18n.global.t('item_delete_success', 1) });
		} catch (error) {
			unexpectedError(error);
			throw error;
		} finally {
			deleting.value = false;
		}
	}

	return { deleting, archiving, isArchived, archive, remove };
}
