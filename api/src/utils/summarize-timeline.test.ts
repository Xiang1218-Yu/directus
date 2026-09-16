import { describe, expect, test } from 'vitest';
import { summarizeTimelineError, summarizeTimelineValue, TIMELINE_SUMMARY_MAX_LENGTH } from './summarize-timeline.js';

describe('summarizeTimelineValue', () => {
	test('serializes plain objects as pretty JSON', () => {
		const result = summarizeTimelineValue({ a: 1, b: 'two' });

		expect(result).toBe(JSON.stringify({ a: 1, b: 'two' }, null, 2));
	});

	test('returns null for null and undefined input', () => {
		expect(summarizeTimelineValue(null)).toBeNull();
		expect(summarizeTimelineValue(undefined)).toBeNull();
	});

	test('redacts configured sensitive key paths at any depth', () => {
		const result = summarizeTimelineValue({
			payload: { password: 'hunter2', name: 'public' },
			deep: { nested: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } } },
			query: { access_token: 'secret-token-value' },
		});

		expect(result).not.toContain('hunter2');
		expect(result).not.toContain('Bearer abc');
		expect(result).not.toContain('sid=1');
		expect(result).not.toContain('secret-token-value');
		expect(result).toContain('public');
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
		value['self'] = value;

		const result = summarizeTimelineValue(value);

		expect(result).toContain('[Circular]');
	});

	test('parses JSON error strings and redacts their sensitive keys', () => {
		const result = summarizeTimelineValue(JSON.stringify({ payload: { password: 'x' }, ok: true }));

		expect(result).toContain('"ok": true');
		expect(result).not.toContain('"x"');
	});

	test('truncates oversized payloads and keeps them below the length bound', () => {
		const result = summarizeTimelineValue({ blob: 'a'.repeat(TIMELINE_SUMMARY_MAX_LENGTH * 2) });

		expect(result!.length).toBeLessThanOrEqual(TIMELINE_SUMMARY_MAX_LENGTH + 20);
		expect(result).toContain('[truncated]');
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
