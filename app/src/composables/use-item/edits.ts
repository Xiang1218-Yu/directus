import { isEqual } from 'lodash';
import { computed, ref, type Ref } from 'vue';

export type ItemEdits = Record<string, any>;

/**
 * Owns the staged-edit delta of an editing session.
 *
 * Boundary contract:
 * - `edits` only holds keys the user changed (a sparse delta), never the whole item. Consumers
 *   (v-form, collab, relation interfaces, auto-save) mutate this object directly.
 * - `hasEdits` is the single dirty-state signal every guard/button must read instead of
 *   re-deriving "is there something to save?".
 * - Nothing in here talks to the network or knows about versions; clearing persisted keys is the
 *   only save-flow concern that mutates the delta.
 */
export function useItemEdits(initial: Ref<ItemEdits> = ref({})) {
	const edits = initial;
	const hasEdits = computed(() => Object.keys(edits.value).length > 0);

	function setEdits(next: ItemEdits) {
		edits.value = next;
	}

	function discard() {
		edits.value = {};
	}

	function apply(values: ItemEdits) {
		edits.value = { ...edits.value, ...values };
	}

	/**
	 * Drops keys whose staged value was persisted as-is (versions coalesce edits into the item
	 * instead of handing the full item back), while keeping keys the user changed in the meantime.
	 */
	function clearPersistedKeys(savedEdits: ItemEdits) {
		for (const key of Object.keys(savedEdits)) {
			if (isEqual(edits.value[key], savedEdits[key])) delete edits.value[key];
		}
	}

	return { edits, hasEdits, setEdits, discard, apply, clearPersistedKeys };
}
