import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearDebugRegistry,
	forgetDebugRun,
	getDebugInput,
	getDebugOutput,
	hasDebugOutputs,
	pruneDebugRegistry,
	rememberDebugInput,
	rememberDebugOutput,
} from './debug-registry.js';

describe('flow debug registry', () => {
	beforeEach(() => {
		clearDebugRegistry();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('remembers the original input of a session', () => {
		rememberDebugInput('s1', { secret: 'plain' });
		expect(getDebugInput('s1')).toEqual({ secret: 'plain' });
	});

	it('remembers original operation outputs keyed by operation key', () => {
		rememberDebugInput('s1', {});
		rememberDebugOutput('s1', 'a', 'plain-output-a');
		rememberDebugOutput('s1', 'b', 'plain-output-b');

		expect(getDebugOutput('s1', 'a')).toBe('plain-output-a');
		expect(hasDebugOutputs('s1', ['a', 'b'])).toBe(true);
		expect(hasDebugOutputs('s1', ['a', 'missing'])).toBe(false);
	});

	it('outputs are isolated per session', () => {
		rememberDebugInput('s1', {});
		rememberDebugInput('s2', {});
		rememberDebugOutput('s1', 'a', 'one');

		expect(getDebugOutput('s2', 'a')).toBeUndefined();
		expect(hasDebugOutputs('s2', ['a'])).toBe(false);
	});

	it('forgetDebugRun removes input and outputs', () => {
		rememberDebugInput('s1', {});
		rememberDebugOutput('s1', 'a', 'x');

		forgetDebugRun('s1');

		expect(getDebugInput('s1')).toBeUndefined();
		expect(hasDebugOutputs('s1', ['a'])).toBe(false);
	});

	it('remembering a new input keeps prior outputs (rerun on the same process)', () => {
		rememberDebugInput('s1', { version: 1 });
		rememberDebugOutput('s1', 'a', 'old-a');
		rememberDebugInput('s1', { version: 2 });

		expect(getDebugInput('s1')).toEqual({ version: 2 });
		expect(getDebugOutput('s1', 'a')).toBe('old-a');
	});

	it('expires entries through pruneDebugRegistry', () => {
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		rememberDebugInput('s1', {});

		vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
		const removed = pruneDebugRegistry(new Date('2026-01-02T00:00:01Z').getTime());

		expect(removed).toBe(1);
		expect(getDebugInput('s1')).toBeUndefined();
	});

	it('keeps non-expired entries when pruning', () => {
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		rememberDebugInput('s1', {});

		vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
		const removed = pruneDebugRegistry(new Date('2026-01-01T12:00:00Z').getTime());

		expect(removed).toBe(0);
		expect(getDebugInput('s1')).toEqual({});
	});
});
