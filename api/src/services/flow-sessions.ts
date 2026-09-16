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
import { type DebugFlowOptions, type FlowDebugStep, getFlowManager } from '../flows.js';
import { validateAccess } from '../permissions/modules/validate-access/validate-access.js';
import { constructFlowTree } from '../utils/construct-flow-tree.js';
import { FLOW_REDACT_KEYS, redactFlowDebugData } from '../utils/flow-redaction.js';
import { getSchema } from '../utils/get-schema.js';
import { isUnauthenticated } from '../utils/is-unauthenticated.js';
import { redactObject } from '../utils/redact-object.js';
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
		// only single-instance deployments can safely reap on boot.
		if (useEnv()['REDIS_ENABLED'] === true) return;

		const database = knex ?? getDatabase();

		await database(COLLECTION)
			.update({ status: 'cancelled', completed_at: new Date() })
			.whereIn('status', ['running', 'cancelling']);
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

	/**
	 * Read one fully hydrated session. Admins see all sessions; other users only their own.
	 */
	async readSession(sessionId: string): Promise<FlowSessionRaw | null> {
		if (this.accountability && isUnauthenticated(this.accountability)) {
			throw new ForbiddenError();
		}

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
		if (this.accountability && isUnauthenticated(this.accountability)) {
			throw new ForbiddenError();
		}

		let query = this.knex(COLLECTION).select('*').where('flow', flowId);

		if (this.accountability && this.accountability.admin === false) {
			query = query.where('user_created', this.accountability.user ?? null);
		}

		const rows = await query.orderBy('date_created', 'desc').limit(100);
		return rows.map((row) => hydrateSessionRow(row as RawSessionRow));
	}

	/**
	 * Create a debug session with a test input and start executing the flow in the background.
	 */
	async startSession(flowId: string, input: unknown, name?: string): Promise<PrimaryKey> {
		if (this.accountability && isUnauthenticated(this.accountability)) {
			throw new ForbiddenError();
		}

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
		} as unknown as Partial<FlowSessionRaw>);

		await this.launch(String(id), flow, redactedInput, { startAtOperation: flow.operation?.id ?? null });

		return id;
	}

	/**
	 * Rerun the flow starting at a previously executed operation (default: the operation that
	 * rejected on the last attempt) or from the trigger when `fromOperation` is null.
	 */
	async rerun(sessionId: string, fromOperation: string | null, input?: unknown): Promise<void> {
		if (this.accountability && isUnauthenticated(this.accountability)) {
			throw new ForbiddenError();
		}

		const session = await this.requireSession(sessionId);

		if (session.user_created && this.accountability && this.accountability.admin === false) {
			await this.assertOwner(session);
		}

		const flow = await this.loadFlowTree(session.flow);

		let nextInput = session.input;

		if (input !== undefined) {
			nextInput = redactFlowDebugData(input, this.flowEnvValues());
		}

		let startAtOperation: string | null;
		let seedData: Record<string, unknown> | null = null;

		if (fromOperation) {
			const executed = session.steps.filter((step) => step.operation === fromOperation);

			if (executed.length === 0) {
				throw new InvalidPayloadError({
					reason: `Operation "${fromOperation}" has not been executed in session "${sessionId}"`,
				});
			}

			startAtOperation = fromOperation;
			seedData = this.buildSeedData(session.steps, nextInput);
		} else {
			startAtOperation = flow.operation?.id ?? null;
		}

		// Conditional update is the concurrency guard: only one request can transition a terminal
		// session back to running, so duplicate clicks never start a second execution.
		const updated = await this.knex(COLLECTION)
			.update({
				status: 'running',
				attempts: this.knex.raw('attempts + 1'),
				started_operation: startAtOperation,
				completed_at: null,
				error: null,
				steps: JSON.stringify([]),
				...(input !== undefined ? { input: JSON.stringify(nextInput) } : {}),
			})
			.where('id', sessionId)
			.whereIn('status', TERMINAL_STATUSES);

		if (updated === 0) {
			throw new InvalidPayloadError({ reason: `Debug session "${sessionId}" is already running` });
		}

		await this.publishEvent('update', [sessionId]);
		await this.launch(String(sessionId), flow, nextInput, { startAtOperation, seedData });
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

		await this.knex(COLLECTION).update({ status: 'cancelling' }).where('id', sessionId).whereIn('status', ['running']);

		await this.publishEvent('update', [sessionId]);
	}

	/**
	 * Manually label a session as succeeded / failed / cancelled. Running sessions can only be
	 * cancelled; use `cancel` to stop an active run.
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

		const result = await super.deleteOne(key, opts);
		return result;
	}

	/**
	 * Start the actual flow execution in the background. Errors always end in a terminal session
	 * status, so no orphaned executions are left behind.
	 */
	private async launch(sessionId: string, flow: Flow, input: unknown, options: DebugFlowOptions): Promise<void> {
		const manager = getFlowManager();

		const runner = async () => {
			const database = getDatabase();
			const schema: SchemaOverview = this.schema ?? (await getSchema({ database }));

			let result: Awaited<ReturnType<typeof manager.runDebugFlow>> | null = null;
			let fatalError: unknown = null;

			try {
				result = await manager.runDebugFlow(
					flow,
					input,
					{
						accountability: this.accountability ?? null,
						database,
						schema,
					},
					{
						...options,
						shouldCancel: async () => (await this.readStatus(sessionId)) === 'cancelling',
						onStep: (step) => this.appendStep(sessionId, step),
					},
				);
			} catch (error) {
				fatalError = error;
			}

			try {
				const session = await this.requireSession(sessionId);

				if (fatalError) {
					await this.finalize(sessionId, 'failed', fatalError);
				} else if (result?.cancelled || session.status === 'cancelling') {
					await this.finalize(sessionId, 'cancelled', null);
				} else if (result?.lastOperationStatus === 'reject') {
					await this.finalize(sessionId, 'failed', result.lastData);
				} else {
					await this.finalize(sessionId, 'succeeded', null);
				}
			} catch (error) {
				// Last resort: ensure no running session is left behind even if finalization fails once
				await this.finalize(sessionId, 'failed', error).catch(() => {
					/* ignore */
				});
			}
		};

		void runner();
	}

	private async finalize(sessionId: string, status: FlowSessionStatus, error: unknown): Promise<void> {
		const updated = await this.knex(COLLECTION)
			.update({
				status,
				completed_at: new Date(),
				error: error === null ? null : JSON.stringify(redactFlowDebugData(error, this.flowEnvValues())),
			})
			.where('id', sessionId)
			// A terminal session (e.g. manually marked) is never overwritten
			.whereIn('status', ['running', 'cancelling']);

		if (updated > 0) {
			await this.publishEvent('update', [sessionId]);
		}
	}

	/**
	 * Persist a single operation result and broadcast it so open debug sessions refresh live.
	 */
	private async appendStep(sessionId: string, step: FlowDebugStep): Promise<void> {
		const session = await this.requireSession(sessionId);

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
			.update({ steps: JSON.stringify(steps) })
			.where('id', sessionId)
			.whereIn('status', ['running', 'cancelling']);

		await this.publishEvent('update', [sessionId]);
	}

	private buildSeedData(steps: FlowSessionStep[], input: unknown): Record<string, unknown> {
		// The latest output of every previously executed operation key seeds the resumed run
		const latest: Record<string, unknown> = {};

		for (const step of steps) {
			latest[step.key] = step.data;
		}

		return {
			$trigger: input,
			$last: input,
			...latest,
		};
	}

	private flowEnvValues(): Record<string, any> {
		const env = useEnv() as Record<string, any>;
		return env['FLOWS_ENV_ALLOW_LIST'] ? env : {};
	}

	private async readStatus(sessionId: string): Promise<FlowSessionStatus | null> {
		const row = await this.knex(COLLECTION).select('status').where('id', sessionId).first();
		return (row?.['status'] as FlowSessionStatus | undefined) ?? null;
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
