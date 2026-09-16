import type { DirectusApiError } from '../types/error.js';
import { RequestError } from '../utils/error.js';

/**
 * Why a queued request failed. Allows callers to distinguish the three failure
 * classes without inspecting HTTP status codes themselves.
 *
 * - `network`: request never reached the API or got no response (offline, DNS, timeout, abort)
 * - `auth`: credentials are missing/expired (HTTP 401/403)
 * - `validation`: the API rejected the request with a 4xx client error
 * - `server`: the API responded with a 5xx error
 * - `cancelled`: the request was cancelled or its page was torn down
 * - `dependency`: a request this one depended on failed
 */
export type ErrorKind = 'network' | 'auth' | 'validation' | 'server' | 'cancelled' | 'dependency';

const AUTH_ERROR_CODES = new Set([
	'INVALID_CREDENTIALS',
	'TOKEN_EXPIRED',
	'INVALID_TOKEN',
	'FORBIDDEN',
	'REFRESH_TOKEN_EXPIRED',
]);

/**
 * Classifies an error thrown while executing a request.
 *
 * API errors remain `RequestError` instances (existing SDK error type is
 * preserved) and are classified via their response status / Directus error
 * codes. Network-level failures (fetch rejection) are classified as `network`.
 */
export const classifyError = (error: unknown): ErrorKind => {
	if (error instanceof QueueCancellationError) return 'cancelled';
	if (error instanceof QueueDependencyError) return 'dependency';

	if (error instanceof RequestError) {
		const status = getErrorStatus(error);

		if (status !== null) {
			if (status === 401 || status === 403) return 'auth';
			if (status >= 400 && status < 500) return 'validation';
			if (status >= 500) return 'server';
		}

		const code = (error.errors as DirectusApiError[] | undefined)?.[0]?.extensions?.code;
		if (code && AUTH_ERROR_CODES.has(code)) return 'auth';
	}

	if (isDomAbortError(error)) return 'cancelled';

	return 'network';
};

/** Whether a classified error may be replayed according to the retry budget. */
export const isRetryableErrorKind = (kind: ErrorKind): boolean => kind === 'network' || kind === 'server';

const getErrorStatus = (error: RequestError): number | null => {
	const response = error.response as { status?: number } | null | undefined;
	return typeof response?.status === 'number' ? response.status : null;
};

const isDomAbortError = (error: unknown): boolean => {
	if (!error || typeof error !== 'object') return false;
	const name = (error as { name?: unknown }).name;
	return name === 'AbortError' || name === 'TimeoutError';
};

/** Base class for errors produced by the offline queue itself. */
export class OfflineQueueError extends Error {
	override readonly name = 'OfflineQueueError';
}

/**
 * Thrown (for the current session) when a queued request is cancelled.
 * Persisted entries are simply removed, so no rejected promise survives a restart.
 */
export class QueueCancellationError extends OfflineQueueError {
	override readonly name = 'QueueCancellationError';
	readonly id: string;

	constructor(id: string, message = `Queued request "${id}" was cancelled`) {
		super(message);
		this.id = id;
	}
}

/** Thrown when a request this entry depends on failed, or a dependency cycle is detected. */
export class QueueDependencyError extends OfflineQueueError {
	override readonly name = 'QueueDependencyError';
	readonly id: string;
	readonly dependencyId: string;

	constructor(id: string, dependencyId: string, message?: string) {
		super(message ?? `Queued request "${id}" depends on failed request "${dependencyId}"`);
		this.id = id;
		this.dependencyId = dependencyId;
	}
}

/**
 * Thrown once the configured retry budget for a queued request is exhausted.
 * The last underlying error is available as `cause`.
 */
export class QueueRetryExhaustedError extends OfflineQueueError {
	override readonly name = 'QueueRetryExhaustedError';
	readonly id: string;
	readonly attempts: number;
	override readonly cause: unknown;

	constructor(id: string, attempts: number, cause: unknown) {
		super(`Queued request "${id}" failed after ${attempts} attempt${attempts === 1 ? '' : 's'}`);
		this.id = id;
		this.attempts = attempts;
		this.cause = cause;
	}
}

/** Thrown when a request cannot be queued (file upload or unsafe method without an idempotency key). */
export class QueueRejectedError extends OfflineQueueError {
	override readonly name = 'QueueRejectedError';
}
