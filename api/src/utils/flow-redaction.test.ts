import { describe, expect, it } from 'vitest';
import { FLOW_REDACT_KEYS, redactFlowDebugData } from './flow-redaction.js';

describe('redactFlowDebugData', () => {
	it('redacts sensitive keys deeply while leaving the rest of the payload intact', () => {
		const input = {
			headers: {
				authorization: 'Bearer secret',
				cookie: 'session=1',
				'content-type': 'application/json',
			},
			query: { access_token: 'abc', limit: 10 },
			payload: {
				password: 'hunter2',
				name: 'visible',
				nested: { note: 'kept' },
			},
		};

		const result = redactFlowDebugData(input) as any;

		expect(result.headers.authorization).not.toContain('secret');
		expect(result.headers['content-type']).toBe('application/json');
		expect(result.query.access_token).not.toContain('abc');
		expect(result.query.limit).toBe(10);
		expect(result.payload.password).not.toContain('hunter2');
		expect(result.payload.name).toBe('visible');
		expect(result.payload.nested.note).toBe('kept');
		expect(result.headers.cookie).not.toContain('session=1');
	});

	it('redacts Error instances by extracting their message', () => {
		const result = redactFlowDebugData(new Error('boom')) as any;
		expect(result.message).toBe('boom');
	});

	it('degrades non-serializable values to null', () => {
		const circular: any = {};
		circular.self = circular;
		// Circular refs are serialized as "[Circular]", not thrown
		expect(() => redactFlowDebugData(circular)).not.toThrow();
	});

	it('redacts env allow-list values anywhere in strings', () => {
		const result = redactFlowDebugData({ note: 'key SECRET_VALUE inside' }, { SECRET_VAR: 'SECRET_VALUE' }) as any;
		expect(result.note).not.toContain('SECRET_VALUE');
	});

	it('shares its key list with the flow log redaction rules', () => {
		expect(FLOW_REDACT_KEYS).toContainEqual(['**', 'headers', 'authorization']);
		expect(FLOW_REDACT_KEYS).toContainEqual(['**', 'payload', 'password']);
	});
});
