import { randomUUID } from 'node:crypto';
import type { FlowRunStatus } from '@directus/types';
import type { Knex } from 'knex';
import { useLogger } from '../logger/index.js';
import { summarizeTimelineError, summarizeTimelineValue } from '../utils/summarize-timeline.js';

const FLOW_RUNS_TABLE = 'directus_flow_runs';
const FLOW_RUN_NODES_TABLE = 'directus_flow_run_nodes';

export interface StartFlowRunOptions {
	flowId: string;
	trigger: string;
	userId?: string | null;
	envValues?: Record<string, unknown>;
}

/**
 * Persists flow run timeline entries.
 *
 * The timeline is an observability feature, never part of flow execution: every write is best
 * effort and failures are logged with identifiers only, so a database issue can never break a
 * running flow. Raw operation payloads are never logged - only redacted, size-bounded summaries
 * are persisted (see {@link summarizeTimelineValue}).
 */
export class FlowRunRecorder {
	private id: string;
	private knex: Knex;
	private envValues?: Record<string, unknown>;
	private logger = useLogger();

	private constructor(id: string, knex: Knex, envValues?: Record<string, unknown>) {
		this.id = id;
		this.knex = knex;
		if (envValues) this.envValues = envValues;
	}

	static async start(knex: Knex, options: StartFlowRunOptions): Promise<FlowRunRecorder | null> {
		const id = randomUUID();

		try {
			await knex(FLOW_RUNS_TABLE).insert({
				id,
				flow: options.flowId,
				trigger: options.trigger,
				status: 'running',
				date_started: knex.fn.now(),
				date_finished: null,
				user_created: options.userId ?? null,
			});

			return new FlowRunRecorder(id, knex, options.envValues);
		} catch {
			useLogger().warn(`Failed to open flow run timeline for flow ${options.flowId}`);
			return null;
		}
	}

	get runId(): string {
		return this.id;
	}

	async startNode(options: {
		operationId: string;
		key: string;
		type: string;
		attempt: number;
		input: unknown;
	}): Promise<string | null> {
		const nodeId = randomUUID();

		try {
			await this.knex(FLOW_RUN_NODES_TABLE).insert({
				id: nodeId,
				flow_run: this.id,
				operation: options.operationId,
				operation_key: options.key,
				operation_type: options.type,
				attempt: options.attempt,
				status: 'running',
				date_started: this.knex.fn.now(),
				date_finished: null,
				input_summary: summarizeTimelineValue(options.input, this.envValues),
				output_summary: null,
				error: null,
			});

			return nodeId;
		} catch {
			this.logger.warn(`Failed to record timeline node start for flow run ${this.id} operation ${options.operationId}`);
			return null;
		}
	}

	async finishNode(
		nodeId: string | null,
		status: 'success' | 'failed',
		options: { output?: unknown; error?: unknown },
	): Promise<void> {
		if (!nodeId) return;

		try {
			await this.knex(FLOW_RUN_NODES_TABLE)
				.update({
					status,
					date_finished: this.knex.fn.now(),
					output_summary: summarizeTimelineValue(options.output ?? null, this.envValues),
					error: options.error === undefined ? null : summarizeTimelineError(options.error, this.envValues),
				})
				.where('id', nodeId);
		} catch {
			this.logger.warn(`Failed to record timeline node finish for node ${nodeId} in flow run ${this.id}`);
		}
	}

	async finish(status: FlowRunStatus): Promise<void> {
		try {
			await this.knex(FLOW_RUNS_TABLE).update({ status, date_finished: this.knex.fn.now() }).where('id', this.id);
		} catch {
			this.logger.warn(`Failed to close flow run timeline for flow run ${this.id}`);
		}
	}
}
