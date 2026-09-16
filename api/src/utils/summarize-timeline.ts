import type { UnknownObject } from '@directus/types';
import { getRedactedString } from '@directus/utils';
import { redactObject } from './redact-object.js';

/**
 * Maximum number of characters of a serialized input/output/error that is persisted to the
 * flow run timeline. Operation payloads are operational data and can be arbitrarily large, so
 * only a bounded preview is ever written to the database.
 */
export const TIMELINE_SUMMARY_MAX_LENGTH = 10_000;

/**
 * Key paths that must never be persisted in a flow run timeline, regardless of the operation
 * that produced the value. Mirrors the redaction rules applied to flow revisions.
 */
export const TIMELINE_REDACT_KEYS: string[][] = [
	['**', 'headers', 'authorization'],
	['**', 'headers', 'cookie'],
	['**', 'query', 'access_token'],
	['**', 'payload', 'password'],
	['**', 'payload', 'token'],
	['**', 'payload', 'tfa_secret'],
	['**', 'payload', 'external_identifier'],
	['**', 'payload', 'auth_data'],
	['**', 'payload', 'credentials'],
	['**', 'payload', 'ai_openai_api_key'],
	['**', 'payload', 'ai_anthropic_api_key'],
	['**', 'payload', 'ai_google_api_key'],
	['**', 'payload', 'ai_openai_compatible_api_key'],
];

/**
 * Serialize a value for persistence in the timeline: sensitive keys and configured env values
 * are redacted, non-serializable values (errors, circular structures) are normalized, and the
 * result is truncated to {@link TIMELINE_SUMMARY_MAX_LENGTH} characters.
 *
 * Returns null when the value serializes to null/undefined so nothing gets stored for it.
 */
export function summarizeTimelineValue(value: unknown, envValues?: Record<string, unknown>): string | null {
	const safe = toSerializable(value);

	if (safe === null) return null;

	// redactObject operates on object structures; wrap primitives so values that happen to
	// contain configured env values are still redacted when serialized
	const redactable: UnknownObject = isPlainRecord(safe) ? safe : { value: safe };

	const redacted = redactObject(
		redactable,
		{
			keys: TIMELINE_REDACT_KEYS,
			...(envValues ? { values: envValues } : {}),
		},
		getRedactedString,
	);

	const output = isPlainRecord(safe) ? redacted : redacted['value'];

	let serialized: string;

	try {
		serialized = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
	} catch {
		return null;
	}

	if (serialized === undefined) return null;

	if (serialized.length > TIMELINE_SUMMARY_MAX_LENGTH) {
		serialized = serialized.slice(0, TIMELINE_SUMMARY_MAX_LENGTH) + '\n…[truncated]';
	}

	return serialized;
}

/**
 * Convert a thrown operation error into the minimal, redacted text representation stored on a
 * timeline node. Stack traces, env values and secrets are never persisted.
 */
export function summarizeTimelineError(error: unknown, envValues?: Record<string, unknown>): string | null {
	if (error === null || error === undefined) return null;

	const serializable = toSerializable(error) as UnknownObject;

	// Errors only expose name/message/cause through the serializer; drop everything else
	const minimal: UnknownObject = { name: 'Error' };

	if (typeof serializable['name'] === 'string') minimal['name'] = serializable['name'];
	if (typeof serializable['message'] === 'string') minimal['message'] = serializable['message'];
	if (serializable['cause'] !== undefined) minimal['cause'] = serializable['cause'];

	return summarizeTimelineValue(minimal, envValues);
}

/**
 * Best-effort conversion of an arbitrary value (including Error instances and circular
 * structures) into a plain JSON-compatible value.
 */
function toSerializable(value: unknown): unknown {
	if (value instanceof Error) {
		const error: UnknownObject = { name: value.name, message: value.message };
		if (value.cause !== undefined) error['cause'] = toSerializable(value.cause);
		return error;
	}

	if (typeof value === 'string') return safeParseJsonString(value) ?? value;

	if (value === null || value === undefined) return null;

	try {
		return JSON.parse(JSON.stringify(value, getCircularReplacer()));
	} catch {
		return null;
	}
}

function safeParseJsonString(value: string): unknown {
	const trimmed = value.trim();

	if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;

	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function isPlainRecord(value: unknown): value is UnknownObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCircularReplacer() {
	const seen = new WeakSet<object>();

	return function (_key: string, value: unknown) {
		if (value instanceof Error) return { name: value.name, message: value.message };

		if (typeof value === 'object' && value !== null) {
			if (seen.has(value)) return '[Circular]';
			seen.add(value);
		}

		return value;
	};
}
