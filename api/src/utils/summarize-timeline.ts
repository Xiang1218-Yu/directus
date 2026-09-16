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
 * Bounds applied while pruning operation payloads into timeline summaries. Raw operation
 * payloads are never persisted - only generic, low-sensitivity fields pass the allowlist below,
 * and even those are capped in depth/size.
 */
const TIMELINE_MAX_DEPTH = 6;
const TIMELINE_MAX_ARRAY_ITEMS = 20;
const TIMELINE_MAX_STRING_LENGTH = 500;
const TIMELINE_MAX_OBJECT_KEYS = 50;

/**
 * Generic structural/non-sensitive field names that may appear in a timeline summary. Anything
 * outside this allowlist is dropped before persistence. This intentionally excludes free-form
 * fields such as `data`, `options` or custom operation keys.
 */
const TIMELINE_ALLOWED_KEYS = new Set([
	// Flow trigger envelope and containers that may carry redactable children
	'$trigger',
	'$last',
	'_omitted_fields',
	'event',
	'headers',
	'query',
	'payload',
	'body',
	'key',
	'keys',
	'collection',
	'method',
	'path',
	'url',
	'status',
	'statusCode',
	'statusText',
	// Common operation inputs/outputs
	'id',
	'ids',
	'type',
	'name',
	'title',
	'description',
	'email',
	'count',
	'total',
	'page',
	'limit',
	'length',
	'success',
	'ok',
	'error',
	'cause',
	'message',
	'code',
	'reason',
	'started_at',
	'finished_at',
	'date',
	'timestamp',
	'duration',
	'attempt',
	'retries',
]);

/**
 * Key names that are never persisted in timeline summaries, even though structurally generic
 * callers may provide them. They must survive pruning so the subsequent redact pass can replace
 * the value with a redaction marker (rather than silently dropping the field).
 */
const TIMELINE_SENSITIVE_KEYS = new Set([
	'authorization',
	'cookie',
	'access_token',
	'password',
	'token',
	'tfa_secret',
	'external_identifier',
	'auth_data',
	'credentials',
	'ai_openai_api_key',
	'ai_anthropic_api_key',
	'ai_google_api_key',
	'ai_openai_compatible_api_key',
]);

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
 * Serialize a value for persistence in the timeline. The value is first pruned to a bounded,
 * allowlist-based summary (raw operation payloads never reach storage), then sensitive keys and
 * configured env values are redacted, and the result is truncated to
 * {@link TIMELINE_SUMMARY_MAX_LENGTH} characters.
 *
 * Returns null when nothing meaningful remains or the value is nullish.
 */
export function summarizeTimelineValue(value: unknown, envValues?: Record<string, unknown>): string | null {
	const safe = toSerializable(value);

	if (safe === null) return null;

	const pruned = pruneToSummary(safe);

	if (pruned === null || pruned === undefined) return null;

	if (isPlainRecord(pruned)) {
		// Drop branches whose children were all pruned themselves, keeping the summary compact
		const compacted = compactObject(pruned);
		if (compacted === null) return null;

		// If the top-level value only reports omissions, nothing meaningful survived pruning
		if (Object.keys(compacted).every((key) => key === '_omitted_fields')) return null;

		return serialize(compacted, envValues);
	}

	if (Array.isArray(pruned)) {
		const compacted = pruned.filter(
			(entry) => entry !== null && !(isPlainRecord(entry) && Object.keys(entry).length === 0),
		);

		if (compacted.length === 0) return null;

		return serialize(compacted, envValues);
	}

	return serialize(pruned, envValues);
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

function serialize(value: unknown, envValues?: Record<string, unknown>): string | null {
	// redactObject operates on object structures; wrap primitives so values that happen to
	// contain configured env values are still redacted when serialized
	const redactable: UnknownObject = isPlainRecord(value) ? value : { value };

	const redacted = redactObject(
		redactable,
		{
			keys: TIMELINE_REDACT_KEYS,
			...(envValues ? { values: envValues } : {}),
		},
		getRedactedString,
	);

	const output = isPlainRecord(value) ? redacted : redacted['value'];

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
 * Reduce an arbitrary value to a bounded summary containing only allowlisted, generic fields.
 * Non-allowlisted object keys and oversized arrays/strings are replaced with omission markers.
 */
function pruneToSummary(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return null;

	if (typeof value === 'string') return truncateString(value);

	if (typeof value === 'number' || typeof value === 'boolean') return value;

	if (depth >= TIMELINE_MAX_DEPTH) return '[depth-limit]';

	if (Array.isArray(value)) {
		if (value.length === 0) return [];

		const items = value.slice(0, TIMELINE_MAX_ARRAY_ITEMS).map((item) => pruneToSummary(item, depth + 1));

		if (value.length > TIMELINE_MAX_ARRAY_ITEMS) {
			items.push(`…[${value.length - TIMELINE_MAX_ARRAY_ITEMS} more items]`);
		}

		return items;
	}

	if (isPlainRecord(value)) {
		const result: UnknownObject = {};
		let kept = 0;
		let dropped = 0;

		for (const [key, entry] of Object.entries(value)) {
			if (!TIMELINE_ALLOWED_KEYS.has(key) && !TIMELINE_SENSITIVE_KEYS.has(key)) {
				dropped += 1;
				continue;
			}

			if (kept >= TIMELINE_MAX_OBJECT_KEYS) {
				dropped += 1;
				continue;
			}

			result[key] = pruneToSummary(entry, depth + 1);
			kept += 1;
		}

		if (dropped > 0) {
			result['_omitted_fields'] = dropped;
		}

		return result;
	}

	return null;
}

/**
 * Remove object branches that only contain omission markers or empty pruned children. Real
 * redaction markers (`--redacted--`) are preserved so auditors can see where secrets were.
 */
function compactObject(value: UnknownObject): UnknownObject | null {
	const result: UnknownObject = {};

	for (const [key, entry] of Object.entries(value)) {
		if (key === '_omitted_fields') {
			result[key] = entry;
			continue;
		}

		if (isPlainRecord(entry)) {
			const child = compactObject(entry);
			if (child !== null && Object.keys(child).length > 0) result[key] = child;
		} else if (Array.isArray(entry)) {
			const children = entry
				.map((item) => (isPlainRecord(item) ? compactObject(item) : item))
				.filter((item) => item !== null && !(isPlainRecord(item) && Object.keys(item).length === 0));

			if (children.length > 0) result[key] = children;
		} else if (entry !== null) {
			result[key] = entry;
		}
	}

	return Object.keys(result).length > 0 ? result : null;
}

function truncateString(value: string): string {
	if (value.length <= TIMELINE_MAX_STRING_LENGTH) return value;
	return value.slice(0, TIMELINE_MAX_STRING_LENGTH) + '…';
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
