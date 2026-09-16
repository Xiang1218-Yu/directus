/**
 * Process-local registry of the ORIGINAL (unredacted) test inputs and operation
 * outputs of debug sessions.
 *
 * The redaction boundary is enforced by design:
 * - The database, websocket payloads and the REST API only ever contain redacted copies.
 * - The flow executor must run with the original test input and original upstream results,
 *   otherwise redacted placeholders would leak into downstream operations.
 *
 * Consequence: resuming a session from a node is only possible on the process that
 * executed the previous attempt. After a restart (or on another instance) the caller has
 * to provide the test input again. Entries expire after `REGISTRY_TTL_MS`.
 */
type RegisteredRun = {
	input: unknown;
	outputs: Map<string, unknown>;
	expiresAt: number;
};

const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

const runs = new Map<string, RegisteredRun>();

function touch(state: RegisteredRun): void {
	state.expiresAt = Date.now() + REGISTRY_TTL_MS;
}

/**
 * Register the original input of a new attempt. Previously remembered outputs are kept,
 * so a resumed attempt can still seed from earlier results.
 */
export function rememberDebugInput(sessionId: string, input: unknown): void {
	const existing = runs.get(sessionId);

	if (existing) {
		existing.input = input;
		touch(existing);
	} else {
		runs.set(sessionId, { input, outputs: new Map(), expiresAt: Date.now() + REGISTRY_TTL_MS });
	}
}

/** Remember the ORIGINAL output of an executed operation key. */
export function rememberDebugOutput(sessionId: string, key: string, output: unknown): void {
	const state = runs.get(sessionId);

	if (!state) return;

	state.outputs.set(key, output);
	touch(state);
}

export function getDebugInput(sessionId: string): unknown | undefined {
	const state = runs.get(sessionId);

	if (!state) return undefined;

	touch(state);
	return state.input;
}

export function hasDebugOutputs(sessionId: string, keys: string[]): boolean {
	const state = runs.get(sessionId);
	if (!state) return false;

	return keys.every((key) => state.outputs.has(key));
}

export function getDebugOutput(sessionId: string, key: string): unknown | undefined {
	return runs.get(sessionId)?.outputs.get(key);
}

export function forgetDebugRun(sessionId: string): void {
	runs.delete(sessionId);
}

/** Remove expired entries. Returns the number of removed entries. */
export function pruneDebugRegistry(now: number = Date.now()): number {
	let removed = 0;

	for (const [id, state] of runs) {
		if (state.expiresAt <= now) {
			runs.delete(id);
			removed += 1;
		}
	}

	return removed;
}

/** Test-only: drop every registered run. */
export function clearDebugRegistry(): void {
	runs.clear();
}
