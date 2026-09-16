import { useEnv } from '@directus/env';
import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
import type {
	AbstractServiceOptions,
	Flow,
	FlowRaw,
	FlowSessionRaw,
	FlowSessionStatus,
	FlowSessionStep,
	MutationOptions,
	PrimaryKey,
	SchemaOverview,
} from '@directus/types';
import { getRedactedString } from '@directus/utils';
import type { Knex } from 'knex';
import { useBus } from '../bus/index.js';
import getDatabase from '../database/index.js';
import {
	forgetDebugRun,
	getDebugInput,
	getDebugOutput,
	hasDebugOutputs,
	rememberDebugInput,
	rememberDebugOutput,
} from '../flows/debug-registry.js';
import { type DebugFlowOptions, type FlowDebugStep, getFlowManager } from '../flows.js';
import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
import { constructFlowTree } from '../utils/construct-flow-tree.js';
import { FLOW_REDACT_KEYS, redactFlowDebugData } from '../utils/flow-redaction.js';
import { getSchema } from '../utils/get-schema.js';
import { isUnauthenticated } from '../utils/is-unauthenticated.js';
import { redactObject } from '../utils/redact-object.js';
import { scheduleSynchronizedJob } from '../utils/schedule.js';
import { ItemsService } from './items.js';

const COLLECTION = 'directus_flow_sessions';

const TERMINAL_STATUSES: FlowSessionStatus[] = ['succeeded', 'failed', 'cancelled'];
const MANUAL_STATUSES: FlowSessionStatus[] = ['succeeded', 'failed', 'cancelled'];

type RawSessionRow = Omit<FlowSessionRaw, 'input' | 'steps' | 'error'> & {
	input: string | unknown;
	steps: string | FlowSessionStep[];
	error: string | unknown;
};

export class FlowSessionsService extends ItemsService<FlowSessionRaw> {
	constructor(options: AbstractServiceOptions) {
		super(COLLECTION, options);
	}

	/**
	 * Sessions left in a non-terminal state by a process that did not shut down cleanly are
	 * marked as cancelled during startup, so they can never appear to run forever.
	 */
	static async reapStaleSessions(knex?: Knex): Promise<void> {
		// In multi-instance setups another process may legitimately be running the sessions;
		// only single-instance deployments can safely reap on boot. Heartbeat-based reaping
		// happens cluster-wide via `scheduleStaleSessionReaping()`.
		if (useEnv()['REDIS_ENABLED'] === true) return;

		const database = knex ?? getDatabase();

		await database(COLLECTION)
			.update({ status: 'cancelled', completed_at: new Date() })
			.whereIn('status', ['running', 'cancelling']);
	}

	/**
	 * Leader-only periodic sweep that cancels sessions whose executor stopped heartbeating
	 * (crash, kill -9, lost process). Safe in multi-instance deployments thanks to the
	 * synchronized job clock.
	 */
	static scheduleStaleSessionReaping(): void {
		scheduleSynchronizedJob('flow-sessions-reaper', '*/2 * * * *', async () => {
			const database = getDatabase();
			const timeout = Number(useEnv()['FLOWS_DEBUG_SESSION_TIMEOUT'] ?? 600) * 1000;
			const cutoff = new Date(Date.now() - timeout);

			await database(COLLECTION)
				.update({ status: 'cancelled', completed_at: new Date() })
				.whereIn('status', ['running', 'cancelling'])
				.andWhere((builder) => builder.whereNull('heartbeat').orWhere('heartbeat', '<', cutoff));
		});
	}

	/**
	 * Load the flow tree for a session and make sure the requester may read the flow.
	 * Inactive flows are intentionally allowed: debugging must work before activation.
	 */
	private async loadFlowTree(flowId: string): Promise<Flow> {
		const flowsService = new ItemsService('directus_flows', {
			knex: this.knex,
			schema: this.schema,
			accountability: this.accountability,
		});

		if (this.accountability && !this.accountability.admin) {
			await validateAccess(
				{
					collection: 'directus_flows',
					action: 'read',
					accountability: this.accountability,
					primaryKeys: [flowId],
				},
				{ knex: this.knex, schema: this.schema },
			);
		}

		const flow = (await flowsService.readOne(flowId, { fields: ['*', 'operations.*'] })) as FlowRaw;
		return constructFlowTree(flow);
	}

	private assertAuthenticated(): void {
		if (this.accountability && isUnauthenticated(this.accountability)) {
			throw new ForbiddenError();
		}
	}

	/**
	 * Read one fully hydrated session. Admins see all sessions; other users only their own.
	 */
	async readSession(sessionId: string): Promise<FlowSessionRaw | null> {
		this.assertAuthenticated();

		let query = this.knex(COLLECTION).select('*').where('id', sessionId);

		if (this.accountability && this.accountability.admin === false) {
			query = query.where('user_created', this.accountability.user ?? null);
		}

		const row = await query.first();
		return row ? hydrateSessionRow(row as RawSessionRow) : null;
	}

	/**
	 * List hydrated sessions of a flow, newest first. Admins see all sessions;
	 * other users only their own.
	 */
	async readFlowSessions(flowId: string): Promise<FlowSessionRaw[]> {
		this.assertAuthenticated();

		let query = this.knex(COLLECTION).select('*').where('flow', flowId);

		if (this.accountability && this.accountability.admin === false) {
			query = query.where('user_created', this.accountability.user ?? null);
		}

		const rows = await query.orderBy('date_created', 'desc').limit(100);
		return rows.map((row) => hydrateSessionRow(row as RawSessionRow));
	}

	/**
	 * Create a debug session with a test input and start executing the flow in the background.
	 * The ORIGINAL input drives execution (kept in process memory); only the redacted copy is
	 * persisted, shared or broadcast.
	 */
	async startSession(flowId: string, input: unknown, name?: string): Promise<PrimaryKey> {
		this.assertAuthenticated();

		const flow = await this.loadFlowTree(flowId);
		const redactedInput = redactFlowDebugData(input, this.flowEnvValues());

		const id = await this.createOne({
			flow: flow.id,
			name: name ?? null,
			status: 'running',
			input: JSON.stringify(redactedInput ?? null),
			steps: JSON.stringify([]),
			error: null,
			attempts: 1,
			started_operation: flow.operation?.id ?? null,
			started_at: new Date(),
			heartbeat: new Date(),
		} as unknown as Partial<FlowSessionRaw>);

		const sessionId = String(id);

		// Original input lives in the executor's memory only
		rememberDebugInput(sessionId, input);

		try {
			await this.launch(sessionId, flow, {
				attempt: 1,
				startAtOperation: flow.operation?.id ?? null,
				input,
			});
		} catch (error) {
			// Synchronous launch failure (e.g. no flow manager) must not leave an orphan
			await this.finalize(sessionId, 1, 'failed', error);
			forgetDebugRun(sessionId);
			throw error;
		}

		return id;
	}

	/**
	 * Rerun the flow starting at a previously executed operation (default: the operation that
	 * rejected on the last attempt) or from the trigger when `fromOperation` is null.
	 *
	 * Re-execution always runs with ORIGINAL inputs and upstream results (process memory).
	 * New input can be supplied (also used after a restart, when memory was lost).
	 */
	async rerun(sessionId: string, fromOperation: string | null, input?: unknown): Promise<void> {
		this.assertAuthenticated();

		const session = await this.requireSession(sessionId);

		if (session.user_created && this.accountability && this.accountability.admin === false) {
			await this.assertOwner(session);
		}

		const flow = await this.loadFlowTree(session.flow);

		let originalInput: unknown;

		if (input !== undefined) {
			originalInput = input;
		} else {
			const remembered = getDebugInput(sessionId);

			if (remembered === undefined) {
				throw new InvalidPayloadError({
					reason:
						'The original test input is no longer available on this process. Provide the test input again to rerun the session.',
				});
			}

			originalInput = remembered;
		}

		let startAtOperation: string | null;
		let seedData: Record<string, unknown> | null = null;

		if (fromOperation) {
			const stepIndex = session.steps.findLastIndex((step) => step.operation === fromOperation);

			if (stepIndex === -1) {
				throw new InvalidPayloadError({
					reason: `Operation "${fromOperation}" has not been executed in session "${sessionId}"`,
				});
			}

			startAtOperation = fromOperation;
			seedData = this.buildSeedData(sessionId, session.steps, stepIndex, originalInput);
		} else {
			startAtOperation = flow.operation?.id ?? null;
		}

		rememberDebugInput(sessionId, originalInput);

		const nextAttempt = session.attempts + 1;

		// Conditional update is the concurrency guard: only one request can transition a terminal
		// session back to running, so duplicate clicks never start a second execution.
		const updated = await this.knex(COLLECTION)
			.update({
				status: 'running',
				attempts: nextAttempt,
				started_operation: startAtOperation,
				completed_at: null,
				error: null,
				steps: JSON.stringify([]),
				heartbeat: new Date(),
				input: JSON.stringify(redactFlowDebugData(originalInput, this.flowEnvValues()) ?? null),
			})
			.where('id', sessionId)
			.whereIn('status', TERMINAL_STATUSES);

		if (updated === 0) {
			throw new InvalidPayloadError({ reason: `Debug session "${sessionId}" is already running` });
		}

		await this.publishEvent('update', [sessionId]);

		try {
			await this.launch(sessionId, flow, { attempt: nextAttempt, startAtOperation, input: originalInput, seedData });
		} catch (error) {
			await this.finalize(sessionId, nextAttempt, 'failed', error);
			throw error;
		}
	}

	/**
	 * Request cancellation of a running session. The background run stops between operations;
	 * terminal sessions are returned unchanged. Idempotent: duplicate clicks converge.
	 */
	async cancel(sessionId: string): Promise<void> {
		const session = await this.requireSession(sessionId);

		if (session.user_created && this.accountability && this.accountability.admin === false) {
			await this.assertOwner(session);
		}

		const updated = await this.knex(COLLECTION)
			.update({ status: 'cancelling' })
			.where('id', sessionId)
			.whereIn('status', ['running']);

		if (updated > 0) {
			await this.publishEvent('update', [sessionId]);
		}
	}

	/**
	 * Manually label a session as succeeded / failed / cancelled. A live session can be
	 * cancelled this way; use `cancel` to request a graceful stop of an active run.
	 */
	async markStatus(sessionId: string, status: FlowSessionStatus): Promise<void> {
		if (!MANUAL_STATUSES.includes(status)) {
			throw new InvalidPayloadError({ reason: `Unsupported debug session status "${status}"` });
		}

		const session = await this.requireSession(sessionId);

		if (session.user_created && this.accountability && this.accountability.admin === false) {
			await this.assertOwner(session);
		}

		if (session.status === 'running' || session.status === 'cancelling') {
			if (status === 'cancelled') {
				await this.cancel(sessionId);
				return;
			}

			throw new InvalidPayloadError({ reason: 'Cancel a running debug session before marking its status' });
		}

		const updated = await this.knex(COLLECTION)
			.update({
				status,
				completed_at: new Date(),
				error: status === 'failed' ? (session.error ?? JSON.stringify({ message: 'Marked as failed' })) : null,
			})
			.where('id', sessionId)
			.whereIn('status', TERMINAL_STATUSES);

		if (updated > 0) {
			await this.publishEvent('update', [sessionId]);
		}
	}

	override async deleteOne(key: PrimaryKey, opts?: MutationOptions): Promise<PrimaryKey> {
		const session = await this.requireSession(String(key));

		if (session.user_created && this.accountability && this.accountability.admin === false) {
			await this.assertOwner(session);
		}

		if (session.status === 'running' || session.status === 'cancelling') {
			await this.cancel(String(key));
			throw new InvalidPayloadError({ reason: 'Debug session is still running; cancel it before deleting' });
		}

		forgetDebugRun(String(key));
		return await super.deleteOne(key, opts);
	}

	/**
	 * Start the actual flow execution in the background. Every outcome ends in a terminal session
	 * status for the SAME attempt, so no orphaned executions or stale attempts are left behind.
	 */
	private async launch(
		sessionId: string,
		flow: Flow,
		options: {
			attempt: number;
			startAtOperation: string | null;
			input: unknown;
			seedData?: Record<string, unknown> | null;
		},
	): Promise<void> {
		const manager = getFlowManager();
		const { attempt } = options;

		const runner = async () => {
			const database = getDatabase();
			const schema: SchemaOverview = this.schema ?? (await getSchema({ database }));

			let result: Awaited<ReturnType<typeof manager.runDebugFlow>> | null = null;
			let fatalError: unknown = null;

			try {
				result = await manager.runDebugFlow(
					flow,
					options.input,
					{
						accountability: this.accountability ?? null,
						database,
						schema,
					},
					{
						startAtOperation: options.startAtOperation,
						...(options.seedData ? { seedData: options.seedData } : {}),
						shouldCancel: async () => (await this.readStatus(sessionId, attempt)) === 'cancelling',
						onStep: (step) => this.appendStep(sessionId, attempt, step),
					} satisfies DebugFlowOptions,
				);
			} catch (error) {
				fatalError = error;
			}

			try {
				const session = await this.requireSession(sessionId);

				if (session.attempts !== attempt) {
					// A newer attempt superseded this runner; it must not write any terminal state
					forgetDebugRun(sessionId);
					return;
				}

				if (fatalError) {
					await this.finalize(sessionId, attempt, 'failed', fatalError);
				} else if (result?.cancelled || session.status === 'cancelling') {
					await this.finalize(sessionId, attempt, 'cancelled', null);
				} else if (result?.lastOperationStatus === 'reject') {
					await this.finalize(sessionId, attempt, 'failed', result.lastData);
				} else {
					await this.finalize(sessionId, attempt, 'succeeded', null);
				}
			} catch (error) {
				// Last resort: guarantee a terminal status for this attempt even if reading fails once
				await this.finalize(sessionId, attempt, 'failed', error).catch(() => {
					/* ignore */
				});
			}
		};

		void runner();
	}

	/**
	 * Write the terminal status of a specific attempt. The attempt guard makes an old runner
	 * unable to overwrite a session that has since been rerun. Terminal sessions are immutable.
	 */
	private async finalize(sessionId: string, attempt: number, status: FlowSessionStatus, error: unknown): Promise<void> {
		const updated = await this.knex(COLLECTION)
			.update({
				status,
				completed_at: new Date(),
				heartbeat: new Date(),
				error: error === null ? null : JSON.stringify(redactFlowDebugData(error, this.flowEnvValues())),
			})
			.where('id', sessionId)
			.andWhere('attempts', attempt)
			// A terminal session (e.g. manually marked) is never overwritten
			.whereIn('status', ['running', 'cancelling']);

		if (updated > 0) {
			forgetDebugRun(sessionId);
			await this.publishEvent('update', [sessionId]);
		}
	}

	/**
	 * Persist a single operation result and broadcast it. The ORIGINAL output is kept in process
	 * memory (to seed resumed executions); only the redacted copy reaches the database.
	 */
	private async appendStep(sessionId: string, attempt: number, step: FlowDebugStep): Promise<void> {
		rememberDebugOutput(sessionId, step.key, step.data);

		const session = await this.requireSession(sessionId);

		if (session.attempts !== attempt) return;

		const redactedStep: FlowSessionStep = {
			operation: step.operation,
			key: step.key,
			status: step.status,
			options: redactObject(
				(step.options ?? {}) as Record<string, unknown>,
				{ keys: FLOW_REDACT_KEYS, values: this.flowEnvValues() },
				getRedactedString,
			),
			data: redactFlowDebugData(step.data, this.flowEnvValues()),
		};

		const steps = [...session.steps, redactedStep];

		await this.knex(COLLECTION)
			.update({ steps: JSON.stringify(steps), heartbeat: new Date() })
			.where('id', sessionId)
			.andWhere('attempts', attempt)
			.whereIn('status', ['running', 'cancelling']);

		await this.publishEvent('update', [sessionId]);
	}

	/**
	 * Rebuild the original keyed data needed to resume at `stepIndex`:
	 * - every distinct operation key keeps its ORIGINAL output (from process memory),
	 * - `$last` is the ORIGINAL output of the step right before the resume point,
	 * - `$trigger` is the original test input.
	 */
	private buildSeedData(
		sessionId: string,
		steps: FlowSessionStep[],
		stepIndex: number,
		input: unknown,
	): Record<string, unknown> {
		const executed = steps.slice(0, stepIndex);
		const keys = [...new Set(executed.map((step) => step.key))];

		if (!hasDebugOutputs(sessionId, keys)) {
			throw new InvalidPayloadError({
				reason:
					'The original upstream results are no longer available on this process. Rerun the session from the trigger to reproduce them.',
			});
		}

		const seed: Record<string, unknown> = {
			$trigger: input,
			$last: input,
		};

		for (const key of keys) {
			seed[key] = getDebugOutput(sessionId, key);
		}

		const predecessor = executed[stepIndex - 1];

		if (predecessor) {
			seed['$last'] = getDebugOutput(sessionId, predecessor.key);
		}

		return seed;
	}

	private flowEnvValues(): Record<string, any> {
		const env = useEnv() as Record<string, any>;
		return env['FLOWS_ENV_ALLOW_LIST'] ? env : {};
	}

	private async readStatus(sessionId: string, attempt: number): Promise<FlowSessionStatus | null> {
		const row = await this.knex(COLLECTION).select('status', 'attempts').where('id', sessionId).first();

		if (!row || Number(row['attempts']) !== attempt) return 'cancelling';

		return (row['status'] as FlowSessionStatus | undefined) ?? null;
	}

	private async requireSession(sessionId: string): Promise<FlowSessionRaw> {
		const row = await this.knex(COLLECTION).select('*').where('id', sessionId).first();

		if (!row) {
			throw new ForbiddenError();
		}

		return hydrateSessionRow(row as RawSessionRow);
	}

	private async assertOwner(session: FlowSessionRaw): Promise<void> {
		if (!this.accountability || !session.user_created || session.user_created !== this.accountability.user) {
			throw new ForbiddenError();
		}
	}

	private async publishEvent(action: 'create' | 'update' | 'delete', keys: string[]): Promise<void> {
		const messenger = useBus();

		messenger.publish('websocket.event', {
			collection: COLLECTION,
			action,
			keys,
			payload: {},
		});
	}
}

function parseJson(value: unknown): unknown {
	if (typeof value !== 'string') return value ?? null;

	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export function hydrateSessionRow(row: RawSessionRow): FlowSessionRaw {
	return {
		...row,
		input: parseJson(row.input),
		steps: (parseJson(row.steps) as FlowSessionStep[] | null) ?? [],
		error: parseJson(row.error),
	};
}
