import { RequestError } from '../utils/error.js';
import type { QueueEntry } from './types.js';

export type ExecutorLike = (entry: QueueEntry, signal: AbortSignal) => Promise<unknown>;

export const makeRequestError = (status: number, code = 'ERROR') =>
	new RequestError(`status ${status}`, {
		response: { status } as unknown as Response,
		errors: [{ message: `status ${status}`, extensions: { code } }],
	});
