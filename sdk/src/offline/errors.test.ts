import { describe, expect, it } from 'vitest';
import { RequestError } from '../utils/error.js';
import {
	classifyError,
	isRetryableErrorKind,
	QueueCancellationError,
	QueueDependencyError,
	QueueRetryExhaustedError,
} from './errors.js';

const apiError = (status: number, code = 'ERROR', message = 'api error') =>
	new RequestError(message, {
		response: { status } as unknown as Response,
		errors: [{ message, extensions: { code } }],
	});

describe('classifyError', () => {
	it('classifies 401/403 RequestErrors as auth', () => {
		expect(classifyError(apiError(401, 'TOKEN_EXPIRED'))).toBe('auth');
		expect(classifyError(apiError(403, 'FORBIDDEN'))).toBe('auth');
	});

	it('classifies other 4xx RequestErrors as validation', () => {
		expect(classifyError(apiError(400, 'FAILED_VALIDATION'))).toBe('validation');
		expect(classifyError(apiError(422, 'RECORD_NOT_UNIQUE'))).toBe('validation');
		expect(classifyError(apiError(404, 'ITEMS_NOT_FOUND'))).toBe('validation');
	});

	it('classifies 5xx RequestErrors as server', () => {
		expect(classifyError(apiError(500, 'INTERNAL_SERVER_ERROR'))).toBe('server');
		expect(classifyError(apiError(503, 'SERVICE_UNAVAILABLE'))).toBe('server');
	});

	it('falls back to auth for token error codes without a status', () => {
		const error = new RequestError('expired', {
			response: {} as Response,
			errors: [{ message: 'expired', extensions: { code: 'INVALID_TOKEN' } }],
		});

		expect(classifyError(error)).toBe('auth');
	});

	it('classifies fetch-level failures as network', () => {
		expect(classifyError(new TypeError('Failed to fetch'))).toBe('network');
		expect(classifyError(new Error('Load failed'))).toBe('network');
	});

	it('classifies abort errors as cancelled', () => {
		expect(classifyError(new QueueCancellationError('id'))).toBe('cancelled');

		const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
		expect(classifyError(abortError)).toBe('cancelled');
	});

	it('classifies dependency failures', () => {
		expect(classifyError(new QueueDependencyError('b', 'a'))).toBe('dependency');
	});

	it('marks only network/server kinds as retryable', () => {
		expect(isRetryableErrorKind('network')).toBe(true);
		expect(isRetryableErrorKind('server')).toBe(true);
		expect(isRetryableErrorKind('auth')).toBe(false);
		expect(isRetryableErrorKind('validation')).toBe(false);
		expect(isRetryableErrorKind('cancelled')).toBe(false);
		expect(isRetryableErrorKind('dependency')).toBe(false);
	});

	it('keeps the exhausted-retry wrapper carrying the original error as cause', () => {
		const original = new TypeError('offline');
		const error = new QueueRetryExhaustedError('id', 4, original);
		expect(classifyError(original)).toBe('network');
		expect(error.cause).toBe(original);
		expect(error.attempts).toBe(4);
	});
});
