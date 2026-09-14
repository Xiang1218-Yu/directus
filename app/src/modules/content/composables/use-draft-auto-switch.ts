import { VERSION_KEY_DRAFT } from '@directus/constants';
import type { Item } from '@directus/types';
import { computed, ref, type Ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Router } from 'vue-router';
import { useNotificationsStore } from '@/stores/notifications';
import type { ContentVersionMaybeNew, ContentVersionWithType } from '@/types/versions';

/**
 * Owns the implicit switch from main-item editing into the draft version.
 *
 * When versioning is enabled but no version is selected, a user's first edit on a read-only main
 * item is transparently staged into the shared draft version: the edit is stashed (and removed
 * from the live delta), the route gains `?version=draft`, and the stashed edit is re-applied once
 * the version context watcher reports the switch completed. If a draft already contains content,
 * auto-switch is disabled so the user's edit can't silently merge into unrelated draft data.
 */
export function useDraftAutoSwitch(options: {
	isNew: Ref<boolean>;
	versioningEnabled: Ref<boolean>;
	readVersionsAllowed: Ref<boolean>;
	createVersionsAllowed: Ref<boolean>;
	updateVersionsAllowed: Ref<boolean>;
	currentVersion: Ref<ContentVersionMaybeNew | null>;
	hasEdits: Ref<boolean>;
	versions: Ref<ContentVersionMaybeNew[]>;
	edits: Ref<Item>;
	router: Pick<Router, 'replace'>;
	route: { query: Record<string, any> };
}) {
	const {
		isNew,
		versioningEnabled,
		readVersionsAllowed,
		createVersionsAllowed,
		updateVersionsAllowed,
		currentVersion,
		hasEdits,
		versions,
		edits,
		router,
		route,
	} = options;

	const notificationsStore = useNotificationsStore();
	const { t } = useI18n();

	const autoSwitchPendingEdits = ref<Item>({});

	const draftVersion = computed(() => versions.value.find((version) => version.key === VERSION_KEY_DRAFT)!);

	const canAutoSwitchToDraft = computed(() => {
		if (isNew.value) return false;
		if (!versioningEnabled.value) return false;
		if (!readVersionsAllowed.value) return false;
		if (currentVersion.value !== null) return false;
		if (hasVersionEdits(draftVersion.value ?? null)) return false;
		if (draftVersion.value?.id === '+') return createVersionsAllowed.value;
		return updateVersionsAllowed.value || createVersionsAllowed.value;
	});

	watch(hasEdits, async (newHasEdits, oldHasEdits) => {
		if (!newHasEdits || oldHasEdits) return;
		if (!canAutoSwitchToDraft.value) return;
		if (!draftVersion.value) return;

		stashAutoSwitchPendingEdits();

		const navigationFailure = await router.replace({
			...route,
			query: { ...route.query, version: VERSION_KEY_DRAFT },
		});

		if (navigationFailure) return;

		notificationsStore.add({
			title: t('editing_draft_version'),
			icon: 'edit',
		});
	});

	return { canAutoSwitchToDraft, draftVersion, applyAutoSwitchPendingEdits };

	function applyAutoSwitchPendingEdits() {
		if (!Object.keys(autoSwitchPendingEdits.value).length) return null;

		const editsToApply = { ...autoSwitchPendingEdits.value };
		autoSwitchPendingEdits.value = {};

		return editsToApply;
	}

	function stashAutoSwitchPendingEdits() {
		autoSwitchPendingEdits.value = { ...edits.value };
		edits.value = {};
	}

	function hasVersionEdits(version: ContentVersionMaybeNew | null) {
		if (!version || version?.id === '+') return false;
		return (version as ContentVersionWithType).delta !== null;
	}
}
