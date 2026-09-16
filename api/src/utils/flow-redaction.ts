import { getRedactedString, isObject } from '@directus/utils';
import { getReplacer, redactObject } from './redact-object.js';

/**
 * Key paths that are always redacted from flow run logs, flow run revisions and
 * shareable debug sessions. Mirrors the log safety rules of the flow engine.
 */
export const FLOW_REDACT_KEYS: string[][] = [
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
 * Redact an arbitrary JSON-serializable debug value (test input, operation output or error)
 * according to the flow log safety rules. Non-serializable values degrade to null.
 */
export function redactFlowDebugData(input: unknown, values: Record<string, any> = {}): unknown {
	let serialized: unknown;

	try {
		serialized = JSON.parse(JSON.stringify(input ?? null, getReplacer(getRedactedString, values)));
	} catch {
		return null;
	}

	if (isObject(serialized)) {
		return redactObject(serialized as Record<string, unknown>, { keys: FLOW_REDACT_KEYS }, getRedactedString);
	}

	return serialized;
}
