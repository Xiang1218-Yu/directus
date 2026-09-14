import type { Item } from '@directus/types';
import { getEndpoint } from '@directus/utils';
import { type ComputedRef, ref, type Ref } from 'vue';
import { useSavePayload } from './lib/use-save-payload';
import { VALIDATION_TYPES } from '@/constants';
import { i18n } from '@/lang';
import sdk, { requestEndpoint } from '@/sdk';
import type { APIError } from '@/types/error';
import { notify } from '@/utils/notify';
import { unexpectedError } from '@/utils/unexpected-error';

export interface UseItemSaveOptions {
	onSaveError?: (error: APIError) => boolean;
}

/**
 * Owns the create/update save of an item.
 *
 * Boundary contract:
 * - Validates the merged payload (including nested-interface errors) before issuing any request;
 *   validation failures populate `validationErrors` and throw, no request is made.
 * - On success the response replaces `item`, the staged delta is cleared and a single success
 *   notification is emitted.
 * - On failure validation errors returned by the server are separated from unexpected errors;
 *   `onSaveError` may swallow a specific error (returning true), everything else goes through the
 *   global unexpected-error handler. The original error is always rethrown.
 * - REST shape is fixed: POST to the collection for new items, PATCH to the item endpoint
 *   otherwise, with the cleared-hiddens payload as the body.
 */
export function useItemSave<T extends Item>(options: {
	collection: Ref<string>;
	isNew: ComputedRef<boolean>;
	itemEndpoint: ComputedRef<string>;
	fields: Ref<any[]>;
	item: Ref<T | null>;
	edits: Ref<Record<string, any>>;
	nestedValidationErrors: Ref<any[]>;
	setItem: (item: T) => void;
	clearEdits: () => void;
	saveOptions?: UseItemSaveOptions;
}) {
	const {
		collection,
		isNew,
		itemEndpoint,
		fields,
		item,
		edits,
		nestedValidationErrors,
		setItem,
		clearEdits,
		saveOptions = {},
	} = options;

	const saving = ref(false);
	const validationErrors = ref<any[]>([]);

	const payload = useSavePayload({ fields, item, edits, isNew });

	async function save(): Promise<T | undefined> {
		saving.value = true;
		validationErrors.value = [];

		const editsWithClearedValues = payload.prepareEdits();
		const errors = payload.validate(editsWithClearedValues, nestedValidationErrors.value ?? []);

		if (errors.length > 0) {
			validationErrors.value = errors;
			saving.value = false;
			throw errors;
		}

		try {
			let response;

			if (isNew.value) {
				response = await sdk.request<T>(
					requestEndpoint(getEndpoint(collection.value), {
						method: 'POST',
						body: editsWithClearedValues,
					}),
				);

				notify({ title: i18n.global.t('item_create_success', 1) });
			} else {
				response = await sdk.request<T>(
					requestEndpoint(itemEndpoint.value, {
						method: 'PATCH',
						body: editsWithClearedValues,
					}),
				);

				notify({ title: i18n.global.t('item_update_success', 1) });
			}

			setItem(response);
			clearEdits();
			return response;
		} catch (error) {
			saveErrorHandler(error);
		} finally {
			saving.value = false;
		}
	}

	function saveErrorHandler(error: any): never {
		if (error?.errors) {
			validationErrors.value = error.errors
				.filter((err: APIError) => VALIDATION_TYPES.includes(err?.extensions?.code))
				.map((err: APIError) => err.extensions);

			const otherErrors = error.errors.filter((err: APIError) => !VALIDATION_TYPES.includes(err?.extensions?.code));

			if (otherErrors.length > 0) {
				otherErrors.forEach((err: APIError) => {
					if (!saveOptions.onSaveError?.(err)) {
						unexpectedError(err);
					}
				});
			}
		} else {
			if (!saveOptions.onSaveError?.(error)) {
				unexpectedError(error);
			}
		}

		throw error;
	}

	return { saving, validationErrors, save, saveErrorHandler, payload };
}
