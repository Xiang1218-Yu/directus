import { useCollection } from '@directus/composables';
import { isSystemCollection } from '@directus/system-data';
import { Alterations, Field, Item, PrimaryKey, Relation } from '@directus/types';
import { getEndpoint, isObject } from '@directus/utils';
import { jsonToGraphQLQuery } from 'json-to-graphql-query';
import { cloneDeep, mergeWith } from 'lodash';
import { type ComputedRef, type Ref } from 'vue';
import { getGraphqlQueryFields } from './lib/get-graphql-query-fields';
import { transformM2AAliases as transformM2AAliasesLib } from './lib/transform-m2a-aliases';
import { i18n } from '@/lang';
import sdk, { requestEndpoint } from '@/sdk';
import { useFieldsStore } from '@/stores/fields';
import { useRelationsStore } from '@/stores/relations';
import { notify } from '@/utils/notify';
import { unexpectedError } from '@/utils/unexpected-error';
import { validateItem } from '@/utils/validate-item';

/** Max URL length before switching to SEARCH method to avoid 414/431 errors */
const MAX_QUERY_URL_LENGTH = 8192;

/**
 * Owns "save as copy": fetch the item (with its duplication field set) through GraphQL, strip
 * primary keys so the server creates new rows, merge in the current staged edits and POST the
 * resulting item. Relation rows the user only reordered/re-linked keep their foreign keys.
 *
 * Kept separate from the regular save because it follows its own read/transform/write protocol;
 * the REST/GraphQL request shapes are preserved verbatim.
 */
export function useItemSaveAsCopy(options: {
	collection: Ref<string>;
	primaryKey: Ref<PrimaryKey | null>;
	collectionInfo: Ref<any>;
	fields: Ref<Field[]>;
	edits: Ref<Item>;
	isNew: ComputedRef<boolean>;
	validationErrors: Ref<any[]>;
	saving: Ref<boolean>;
	nestedValidationErrors: Ref<any[]>;
	saveErrorHandler: (error: any) => never;
}) {
	const {
		collection,
		primaryKey,
		collectionInfo,
		fields,
		edits,
		isNew,
		validationErrors,
		saving,
		nestedValidationErrors,
		saveErrorHandler,
	} = options;

	const { primaryKeyField } = useCollection(collection);

	return { saveAsCopy };

	async function saveAsCopy(): Promise<PrimaryKey | null> {
		saving.value = true;
		validationErrors.value = [];

		const duplicationFields = collectionInfo.value?.meta?.item_duplication_fields ?? [];

		const { queryFields, m2aAliasMap } = getGraphqlQueryFields(duplicationFields, collection.value);
		const alias = isSystemCollection(collection.value) ? collection.value.substring(9) : collection.value;

		const query = jsonToGraphQLQuery({
			query: {
				item: {
					__aliasFor: `${alias}_by_id`,
					__args: {
						id: primaryKey.value,
					},
					...queryFields,
				},
			},
		});

		const graphqlEndpoint = isSystemCollection(collection.value) ? '/graphql/system' : '/graphql';
		let response;

		try {
			response = await sdk.request<Item>(
				requestEndpoint(graphqlEndpoint, {
					method: 'POST',
					body: { query },
				}),
			);
		} catch (error) {
			saving.value = false;
			unexpectedError(error);
			throw error;
		}

		// Transform aliased M2A fields back to their original names
		const itemData = transformM2AAliasesLib(response.item, m2aAliasMap);

		const newItem: Item = {
			...(itemData || {}),
			...cloneDeep(edits.value),
		};

		clearPrimaryKey(primaryKeyField.value, newItem);

		const fieldsStore = useFieldsStore();
		const relationsStore = useRelationsStore();
		const relations = relationsStore.getRelationsForCollection(collection.value);

		for (const relation of relations) {
			const oneField = relation.meta?.one_field;
			if (!oneField || !(oneField in newItem)) continue;

			const relatedPrimaryKeyField = fieldsStore.getPrimaryKeyFieldForCollection(relation.collection);
			if (!relatedPrimaryKeyField) continue;

			const existsJunctionRelated = relationsStore.relations.find(
				(r) => r.collection === relation.collection && r.meta?.many_field === relation.meta?.junction_field,
			);

			if (Array.isArray(newItem[oneField])) {
				const existingItems = await findExistingRelatedItems(
					relation,
					relatedPrimaryKeyField,
					itemData,
					duplicationFields,
				);

				if (existingItems.length > 0) {
					newItem[oneField] = newItem[oneField].map((relatedItem: Item | PrimaryKey) => {
						const existingItem = existingItems.find(
							(existingItem) =>
								// Loose equality because GraphQL always returns primary key as string
								existingItem[relatedPrimaryKeyField.field] ==
								(isObject(relatedItem) ? relatedItem[relatedPrimaryKeyField.field] : relatedItem),
						);

						if (existingItem) {
							clearPrimaryKey(primaryKeyField.value, existingItem);
							clearJunctionRelatedKey(relation, existsJunctionRelated, existingItem, fieldsStore);
							relatedItem = existingItem;
						}

						return relatedItem;
					});
				}
			} else if (isObject(newItem[oneField])) {
				const newRelatedItem = newItem[oneField] as Alterations;

				const existingItems = (
					await findExistingRelatedItems(relation, relatedPrimaryKeyField, itemData, duplicationFields)
				).filter((item) => !newRelatedItem.delete.includes(item[relatedPrimaryKeyField.field]));

				for (const item of newRelatedItem.update) {
					let data;

					const existingItemIndex = existingItems.findIndex(
						(existingItem) => existingItem[relatedPrimaryKeyField.field] === item[relatedPrimaryKeyField.field],
					);

					if (existingItemIndex > -1) {
						data = mergeWith(existingItems[existingItemIndex], item, (objValue) => {
							if (Array.isArray(objValue)) return objValue;
							return;
						});

						existingItems.splice(existingItemIndex, 1);
					} else {
						data = item;
					}

					clearPrimaryKey(relatedPrimaryKeyField, data);
					clearJunctionRelatedKey(relation, existsJunctionRelated, data, fieldsStore);

					newRelatedItem.create.push(data);
				}

				for (const item of existingItems) {
					clearPrimaryKey(relatedPrimaryKeyField, item);

					newRelatedItem.create.push(item);
				}

				newRelatedItem.update.length = 0;
			}
		}

		const errors = validateItem(newItem, fields.value, isNew.value);
		if (nestedValidationErrors.value?.length) errors.push(...nestedValidationErrors.value);

		if (errors.length > 0) {
			validationErrors.value = errors;
			saving.value = false;
			throw errors;
		}

		try {
			const response = await sdk.request<Item>(
				requestEndpoint(getEndpoint(collection.value), {
					method: 'POST',
					body: newItem,
				}),
			);

			notify({
				title: i18n.global.t('item_create_success', 1),
			});

			// Reset edits to the current item
			edits.value = {};

			return primaryKeyField.value ? response[primaryKeyField.value.field] : null;
		} catch (error) {
			saveErrorHandler(error);
			throw error;
		} finally {
			saving.value = false;
		}
	}

	async function findExistingRelatedItems(
		relation: Relation,
		relatedPrimaryKeyField: Field,
		itemData: Item,
		duplicationFields: string[],
	): Promise<Item[]> {
		const existingRelatedItem = itemData[relation.meta!.one_field!];

		if (!existingRelatedItem) return [];

		const existingIds = existingRelatedItem.filter(
			(item: unknown) => isObject(item) && relatedPrimaryKeyField.field in item,
		);

		if (existingIds.length === 0) return [];

		const fieldsToFetch = new Set(
			duplicationFields.reduce((accumulator, currentValue) => {
				const [onePart, ...remainingParts] = currentValue.split('.');

				if (onePart === relation.meta!.one_field! && remainingParts.length > 0)
					accumulator.push(remainingParts.join('.'));

				return accumulator;
			}, [] as string[]),
		);

		if (fieldsToFetch.size > 0) fieldsToFetch.add(relatedPrimaryKeyField.field);

		const endpoint = getEndpoint(relation.collection);
		const requestFields = Array.from(fieldsToFetch);
		const filter = { [relation.field]: { _eq: primaryKey.value } };
		const query = { fields: requestFields, filter };

		const queryString = new URLSearchParams({
			fields: requestFields.join(','),
			filter: JSON.stringify(filter),
		}).toString();

		const useSearch = queryString.length + endpoint.length > MAX_QUERY_URL_LENGTH;

		const options = useSearch ? { method: 'SEARCH' as const, body: { query } } : { params: query };

		return await sdk.request<Item[]>(requestEndpoint(endpoint, options));
	}

	function clearPrimaryKey(primaryKeyField: Field | null, item: Item) {
		if (primaryKeyField?.schema?.has_auto_increment || primaryKeyField?.meta?.special?.includes('uuid')) {
			delete item[primaryKeyField.field];
		}
	}

	function clearJunctionRelatedKey(
		relation: Relation,
		existsJunctionRelated: Relation | undefined,
		item: Item,
		fieldsStore: ReturnType<typeof useFieldsStore>,
	) {
		if (!relation.meta?.junction_field || !isObject(item[relation.meta.junction_field]) || !existsJunctionRelated)
			return;

		let junctionRelatedPrimaryKeyField = null;

		if (existsJunctionRelated.related_collection)
			junctionRelatedPrimaryKeyField = fieldsStore.getPrimaryKeyFieldForCollection(
				existsJunctionRelated.related_collection,
			);
		else if (existsJunctionRelated.meta?.one_collection_field && item[existsJunctionRelated.meta.one_collection_field])
			junctionRelatedPrimaryKeyField = fieldsStore.getPrimaryKeyFieldForCollection(
				item[existsJunctionRelated.meta.one_collection_field],
			);

		const relatedItem = item[relation.meta.junction_field];

		// Only deep-duplicate the related item when it carries edited content. If it's just a PK
		// reference (e.g. a link-only reorder update), keep the key so the copy re-links to it.
		const relatedPkField = junctionRelatedPrimaryKeyField?.field;
		const carriesEditedContent = Object.keys(relatedItem).some((key) => key !== relatedPkField);

		if (!carriesEditedContent) return;

		clearPrimaryKey(junctionRelatedPrimaryKeyField, relatedItem);
	}
}
