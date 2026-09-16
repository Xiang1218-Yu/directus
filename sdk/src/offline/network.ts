import type { NetworkMonitor, NetworkStatusListener } from './types.js';

/**
 * Network monitor backed by the browser `online`/`offline` events and
 * `navigator.onLine`. The event target is injectable to make testing
 * straightforward.
 */
export const browserNetworkMonitor = (
	navigatorLike: Navigator = globalThis.navigator,
	eventTarget: EventTarget = globalThis,
): NetworkMonitor => {
	return {
		isOnline: () => (navigatorLike ? navigatorLike.onLine : true),
		subscribe(listener: NetworkStatusListener) {
			const online = () => listener(true);
			const offline = () => listener(false);

			eventTarget.addEventListener('online', online);
			eventTarget.addEventListener('offline', offline);

			return () => {
				eventTarget.removeEventListener('online', online);
				eventTarget.removeEventListener('offline', offline);
			};
		},
	};
};

/**
 * Network monitor that always reports the given state and can be toggled
 * manually. Useful in non-browser environments and in tests.
 */
export const staticNetworkMonitor = (initialOnline = true): NetworkMonitor & { setOnline(online: boolean): void } => {
	let online = initialOnline;
	const listeners = new Set<NetworkStatusListener>();

	return {
		isOnline: () => online,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setOnline(next: boolean) {
			if (next === online) return;
			online = next;
			for (const listener of listeners) listener(next);
		},
	};
};
