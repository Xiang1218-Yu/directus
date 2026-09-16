import { realtime } from '@directus/sdk';
import type { FlowSessionRaw, FlowSessionStatus } from '@directus/types';
import { computed, onScopeDispose, ref, type Ref } from 'vue';
import api from '@/api';
import { sdk } from '@/sdk';
import { getRootPath } from '@/utils/get-root-path';
import { unexpectedError } from '@/utils/unexpected-error';

type SubscriptionMessage = {
	type: 'subscription';
	event: 'init' | 'create' | 'update' | 'delete';
	data: FlowSessionRaw[] | string[];
	uid?: string;
};

const realtimeClient = sdk.with(
	realtime({
		authMode: 'strict',
		connect: false,
		url: `${sdk.url.protocol === 'https:' ? 'wss' : 'ws'}://${sdk.url.host}${getRootPath()}websocket`,
		reconnect: { delay: 1000, retries: 10 },
	}),
);

export function useFlowSessions(flowId: Ref<string>) {
	const sessions = ref<FlowSessionRaw[]>([]);
	const loading = ref(false);
	const error = ref<unknown>(null);
	const creating = ref(false);
	const actionPending = ref(false);
	const liveConnected = ref(false);

	const runningSessions = computed(() =>
		sessions.value.filter((session) => session.status === 'running' || session.status === 'cancelling'),
	);

	const subscriptionUid = `flow-sessions-${flowId.value}`;
	let removeMessageHandler: (() => void) | undefined;

	async function refresh() {
		loading.value = true;
		error.value = null;

		try {
			const response = await api.get(`/flows/${flowId.value}/sessions`);
			sessions.value = response.data.data ?? [];
		} catch (err) {
			error.value = err;
		} finally {
			loading.value = false;
		}
	}

	async function createSession(input: unknown, name?: string) {
		creating.value = true;

		try {
			const response = await api.post(`/flows/${flowId.value}/sessions`, { input, name });
			upsertSession(response.data.data as FlowSessionRaw);
			return response.data.data as FlowSessionRaw;
		} catch (err) {
			unexpectedError(err);
			throw err;
		} finally {
			creating.value = false;
		}
	}

	async function rerun(sessionId: string, operation: string | null = null, input?: unknown) {
		actionPending.value = true;

		try {
			const response = await api.post(`/flows/sessions/${sessionId}/rerun`, {
				operation,
				...(input !== undefined ? { input } : {}),
			});

			upsertSession(response.data.data as FlowSessionRaw);
		} catch (err) {
			unexpectedError(err);
		} finally {
			actionPending.value = false;
		}
	}

	async function cancel(sessionId: string) {
		actionPending.value = true;

		try {
			const response = await api.post(`/flows/sessions/${sessionId}/cancel`);
			upsertSession(response.data.data as FlowSessionRaw);
		} catch (err) {
			unexpectedError(err);
		} finally {
			actionPending.value = false;
		}
	}

	async function markStatus(sessionId: string, status: FlowSessionStatus) {
		actionPending.value = true;

		try {
			const response = await api.patch(`/flows/sessions/${sessionId}`, { status });
			upsertSession(response.data.data as FlowSessionRaw);
		} catch (err) {
			unexpectedError(err);
		} finally {
			actionPending.value = false;
		}
	}

	async function remove(sessionId: string) {
		actionPending.value = true;

		try {
			await api.delete(`/flows/sessions/${sessionId}`);
			sessions.value = sessions.value.filter((session) => session.id !== sessionId);
		} catch (err) {
			unexpectedError(err);
		} finally {
			actionPending.value = false;
		}
	}

	function upsertSession(session: FlowSessionRaw) {
		const index = sessions.value.findIndex((existing) => existing.id === session.id);

		if (index === -1) {
			sessions.value = [session, ...sessions.value];
		} else {
			sessions.value = sessions.value.map((existing, i) => (i === index ? session : existing));
		}
	}

	function onSubscriptionMessage(message: SubscriptionMessage) {
		if (message.type !== 'subscription' || message.uid !== subscriptionUid) return;
		if (!Array.isArray(message.data)) return;

		if (message.event === 'delete') {
			const removed = new Set(message.data as string[]);
			sessions.value = sessions.value.filter((session) => !removed.has(session.id));
			return;
		}

		for (const session of message.data as FlowSessionRaw[]) {
			if (session && session.flow === flowId.value) upsertSession(session);
		}
	}

	async function connectLive() {
		if (liveConnected.value) return;

		try {
			await realtimeClient.connect();

			removeMessageHandler = realtimeClient.onWebSocket('message', onSubscriptionMessage) as unknown as () => void;

			await realtimeClient.sendMessage({
				type: 'subscribe',
				collection: 'directus_flow_sessions',
				query: { filter: { flow: { _eq: flowId.value } }, limit: -1 },
				uid: subscriptionUid,
			});

			liveConnected.value = true;
		} catch {
			// Subscriptions are an enhancement; manual refresh keeps the UI working
			liveConnected.value = false;
		}
	}

	function disconnectLive() {
		if (!liveConnected.value) return;

		try {
			void realtimeClient.sendMessage({ type: 'unsubscribe', uid: subscriptionUid });
			removeMessageHandler?.();
		} catch {
			/* ignore */
		}

		liveConnected.value = false;
	}

	onScopeDispose(disconnectLive);

	return {
		sessions,
		loading,
		error,
		creating,
		actionPending,
		liveConnected,
		runningSessions,
		refresh,
		createSession,
		rerun,
		cancel,
		markStatus,
		remove,
		connectLive,
		disconnectLive,
	};
}
