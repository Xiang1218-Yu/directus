import type { Field } from '@directus/types';
import { type ComputedRef, type Ref } from 'vue';
import type { ContentVersionMaybeNew } from '@/types/versions';
import { clearHiddenFieldsByCondition } from '@/utils/clear-hidden-fields-by-condition';
import { getDefaultValuesFromFields } from '@/utils/get-default-values-from-fields';
import { mergeItemData } from '@/utils/merge-item-data';
import { pushGroupOptionsDown } from '@/utils/push-group-options-down';
import { validateItem } from '@/utils/validate-item';

/**
 * Shared boundary between item saves (use-item) and version publishes (content page): given the
 * permitted fields, defaults, persisted item and staged edits, produce (a) the payload that should
 * reach the REST endpoint and (b) the merged value client-side validation has to run against.
 */
export function useSavePayload(options: {
	fields: Ref<Field[]>;
	defaultValues?: ComputedRef<Record<string, any>>;
	item: Ref<Record<string, any> | null>;
	edits: Ref<Record<string, any>>;
	isNew: Ref<boolean>;
}) {
	const { fields, item, edits, isNew } = options;
	const defaultValues = options.defaultValues ?? getDefaultValuesFromFields(fields);

	function prepareEdits() {
		return clearHiddenFieldsByCondition(
			edits.value,
			pushGroupOptionsDown(fields.value),
			defaultValues.value,
			item.value,
		);
	}

	function buildValidationPayload(overrides?: Record<string, any>) {
		return mergeItemData(defaultValues.value, item.value ?? {}, overrides ?? edits.value);
	}

	function validate(overrides?: Record<string, any>, extraErrors: any[] = []) {
		const errors = validateItem(buildValidationPayload(overrides), pushGroupOptionsDown(fields.value), isNew.value);
		errors.push(...extraErrors);
		return errors;
	}

	/**
	 * Client-only validation used before promoting a version. Mirrors the rules of the save path,
	 * but evaluates conditions against the version and never blocks on nested field validation.
	 */
	function validateForVersion(currentVersion: ContentVersionMaybeNew | null): any[] {
		const payloadToValidate = mergeItemData(defaultValues.value, item.value ?? {}, edits.value);
		return validateItem(payloadToValidate, pushGroupOptionsDown(fields.value), false, false, currentVersion);
	}

	return {
		defaultValues,
		prepareEdits,
		buildValidationPayload,
		validate,
		validateForVersion,
	};
}
