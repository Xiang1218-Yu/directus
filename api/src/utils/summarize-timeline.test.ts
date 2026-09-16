import { describe, expect, test } from 'vitest';
import { summarizeTimelineError, summarizeTimelineValue, TIMELINE_SUMMARY_MAX_LENGTH } from './summarize-timeline.js';

describe('summarizeTimelineValue', () => {
	test('serializes whitelisted object fields as pretty JSON', () => {
		const result = summarizeTimelineValue({ id: 'abc', name: 'two', status: 200 });

		expect(result).toBe(JSON.stringify({ id: 'abc', name: 'two', status: 200 }, null, 2));
	});

	test('returns null for null and undefined input', () => {
		expect(summarizeTimelineValue(null)).toBeNull();
		expect(summarizeTimelineValue(undefined)).toBeNull();
	});

	test('returns null when every field is pruned by the allowlist', () => {
		expect(summarizeTimelineValue({ secret: 'x', arbitrary: { nested: true } })).toBeNull();
		expect(summarizeTimelineValue({})).toBeNull();
	});

	test('drops non-allowlisted fields and reports how many were omitted', () => {
		const result = summarizeTimelineValue({
			id: 1,
			payload: { password: 'hunter2', internal_status: 'public' },
			custom_business_field: 'leak-me',
			options: { keep: false },
		});

		expect(result).toContain('"id": 1');
		expect(result).not.toContain('hunter2');
		expect(result).not.toContain('leak-me');
		expect(result).not.toContain('public');
		expect(result).not.toContain('custom_business_field');
		expect(result).toContain('"_omitted_fields": 2');
	});

	test('redacts configured sensitive key paths that survive the allowlist at any depth', () => {
		const result = summarizeTimelineValue({
			$trigger: {
				headers: { authorization: 'Bearer abc', cookie: 'sid=1' },
				query: { access_token: 'secret-token-value', page: 2 },
				payload: { password: 'hunter2', name: 'public', email: 'a@example.com' },
			},
		});

		expect(result).not.toContain('hunter2');
		expect(result).not.toContain('Bearer abc');
		expect(result).not.toContain('sid=1');
		expect(result).not.toContain('secret-token-value');
		expect(result).toMatch(/--redacted--/);
	});

	test('redacts configured env values appearing inside strings', () => {
		const result = summarizeTimelineValue({ message: 'authenticated with SUPER_SECRET_VALUE now' }, {
			API_TOKEN: 'SUPER_SECRET_VALUE',
		} as Record<string, unknown>);

		expect(result).not.toContain('SUPER_SECRET_VALUE');
		expect(result).toContain('--redacted:API_TOKEN--');
	});

	test('does not leak stack traces for Error values', () => {
		const error = new Error('boom');

		const result = summarizeTimelineValue(error);

		expect(result).toContain('boom');
		expect(result).not.toContain('at ');
		expect(result).not.toContain('Error: boom\n');
	});

	test('handles circular structures without throwing', () => {
		const value: Record<string, unknown> = { name: 'root' };
		value['keys'] = [value];

		const result = summarizeTimelineValue({ $trigger: value });

		expect(result).toContain('[Circular]');
	});

	test('parses JSON error strings and prunes their non-allowlisted keys', () => {
		const result = summarizeTimelineValue(JSON.stringify({ payload: { password: 'x' }, ok: true }));

		expect(result).toContain('"ok": true');
		expect(result).not.toContain('"x"');
	});

	test('caps array length and individual string length', () => {
		const result = summarizeTimelineValue({
			id: 'x',
			keys: Array.from({ length: 50 }, (_, index) => `key-${index}`),
			name: 'a'.repeat(2_000),
		});

		expect(result).toContain('more items');
		expect(result).toContain('…');
		expect(result).not.toContain('key-49');
		expect(result!.length).toBeLessThan(4_000);
	});

	test('truncates oversized individual strings and keeps the whole summary bounded', () => {
		// A single long field is capped per-value before serialization
		const single = summarizeTimelineValue({ name: 'a'.repeat(2_000) });
		expect(single!.length).toBeLessThan(1_000);
		expect(single).toContain('…');
		expect(single).not.toContain('a'.repeat(600));

		// Many bounded fields can still exceed the global cap and are truncated as a whole
		const many = summarizeTimelineValue({
			keys: Array.from({ length: 150 }, () => ({
				id: 'id',
				name: 'x'.repeat(400),
				description: 'y'.repeat(400),
			})),
		});

		expect(many!.length).toBeLessThanOrEqual(TIMELINE_SUMMARY_MAX_LENGTH + 20);
		expect(many).toContain('[truncated]');
	});

	test('never persists arbitrary operation outputs wholesale', () => {
		const operationOutput = {
			customer: { ssn: '123-45-6789', email: 'a@example.com' },
			tokens: ['t1', 't2'],
			internal_note: 'debug data',
		};

		const result = summarizeTimelineValue(operationOutput);

		// The whole object is non-allowlisted, so no operational data reaches storage
		expect(result).toBeNull();
	});
});

describe('summarizeTimelineError', () => {
	test('keeps only name, message and cause', () => {
		const error = Object.assign(new Error('denied'), { secret: 'leak', stack: 'stack-lines' });

		const result = summarizeTimelineError(error);

		expect(result).toContain('denied');
		expect(result).not.toContain('leak');
		expect(result).not.toContain('stack-lines');
	});

	test('redacts env values embedded in the error message', () => {
		const result = summarizeTimelineError(new Error('request failed with token ENV_SECRET_VALUE'), {
			SERVICE_TOKEN: 'ENV_SECRET_VALUE',
		} as Record<string, unknown>);

		expect(result).not.toContain('ENV_SECRET_VALUE');
	});

	test('serializes nested causes', () => {
		const cause = new Error('inner');
		const result = summarizeTimelineError(new Error('outer', { cause }));

		expect(result).toContain('outer');
		expect(result).toContain('inner');
	});

	test('returns null for nullish errors', () => {
		expect(summarizeTimelineError(null)).toBeNull();
		expect(summarizeTimelineError(undefined)).toBeNull();
	});
});
