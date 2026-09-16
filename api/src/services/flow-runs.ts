import { useEnv } from '@directus/env';
import { ForbiddenError, InvalidQueryError } from '@directus/errors';
import type { Accountability, FlowRun, FlowRunNode, SchemaOverview } from '@directus/types';
import type { Knex } from 'knex';
import getDatabase from '../database/index.js';
import { fetchPermissions } from '../permissions/lib/fetch-permissions.js';
import { fetchPolicies } from '../permissions/lib/fetch-policies.js';
import { FlowsService } from './flows.js';

const FLOW_RUNS_TABLE = 'directus_flow_runs';
const FLOW_RUN_NODES_TABLE = 'directus_flow_run_nodes';
const FLOWS_TABLE = 'directus_flows';

export const FLOW_RUN_STATUSES = ['running', 'success', 'failed'] as const;

const RUN_FIELDS = ['id', 'flow', 'trigger', 'status', 'date_started', 'date_finished', 'user_created'] as const;

const NODE_FIELDS = [
	'id',
	'operation',
	'operation_key',
	'operation_type',
	'attempt',
	'status',
	'date_started',
	'date_finished',
	'input_summary',
	'output_summary',
	'error',
] as const;

export interface ReadFlowRunsQuery {
	flow?: string;
	status?: (typeof FLOW_RUN_STATUSES)[number];
	triggeredAfter?: string;
	triggeredBefore?: string;
	page?: number;
	limit?: number;
}

export interface FlowRunsPage {
	data: FlowRun[];
	meta: {
		total: number;
		limit: number;
		page: number;
		total_pages: number;
	};
}

interface ServiceContext {
	knex?: Knex;
	schema: SchemaOverview;
	accountability: Accountability | null;
}

/**
 * Read-only access to the flow run timeline.
 *
 * This service intentionally does not extend ItemsService: timeline rows are never user-writable
 * through the API, and every read is scoped to flows the accountability is allowed to read.
 */
export class FlowRunsService {
	private knex: Knex;
	private schema: SchemaOverview;
	private accountability: Accountability | null;

	constructor(context: ServiceContext) {
		this.knex = context.knex ?? getDatabase();
		this.schema = context.schema;
		this.accountability = context.accountability;
	}

	async readByQuery(query: ReadFlowRunsQuery): Promise<FlowRunsPage> {
		const allowedFlowIds = await this.getAllowedFlowIds();

		const status = validateStatus(query.status);
		const page = query.page && query.page > 0 ? Math.floor(query.page) : 1;
		const limit = this.resolveLimit(query.limit);

		// Empty set short-circuit: knex's empty whereIn behavior is dialect dependent
		if (allowedFlowIds.length === 0) {
			return { data: [], meta: { total: 0, limit, page, total_pages: 1 } };
		}

		const base = this.knex(FLOW_RUNS_TABLE).whereIn('flow', allowedFlowIds);

		if (query.flow) {
			base.andWhere('flow', query.flow);
		}

		if (status) {
			base.andWhere('status', status);
		}

		if (query.triggeredAfter) {
			base.andWhere('date_started', '>=', query.triggeredAfter);
		}

		if (query.triggeredBefore) {
			base.andWhere('date_started', '<=', query.triggeredBefore);
		}

		const countQuery = base.clone().clearSelect().clearOrder().count('*', { as: 'count' });

		const countResult = (await countQuery) as { count: number | string }[];
		const total = Number(countResult[0]?.['count'] ?? 0);

		const data = (await base
			.clone()
			.select([...RUN_FIELDS])
			.orderBy('date_started', 'desc')
			.orderBy('id', 'desc')
			.limit(limit)
			.offset((page - 1) * limit)) as FlowRun[];

		return {
			data,
			meta: {
				total,
				limit,
				page,
				total_pages: limit > 0 ? Math.ceil(total / limit) : 1,
			},
		};
	}

	async readOne(id: string): Promise<FlowRun & { nodes: FlowRunNode[] }> {
		const allowedFlowIds = await this.getAllowedFlowIds();

		const run = (await this.knex(FLOW_RUNS_TABLE)
			.select([...RUN_FIELDS])
			.where('id', id)
			.first()) as FlowRun | undefined;

		// Treat runs of non-accessible flows as non-existent instead of leaking their existence
		if (!run || !allowedFlowIds.includes(run.flow)) {
			throw new ForbiddenError({ reason: `You don't have access to flow run "${id}".` });
		}

		const nodes = (await this.knex(FLOW_RUN_NODES_TABLE)
			.select([...NODE_FIELDS])
			.where('flow_run', id)
			.orderBy('date_started', 'asc')
			.orderBy('attempt', 'asc')
			.orderBy('id', 'asc')) as FlowRunNode[];

		return { ...run, nodes };
	}

	private async getAllowedFlowIds(): Promise<string[]> {
		if (this.accountability?.admin === true) {
			const flows = (await this.knex(FLOWS_TABLE).select('id')) as { id: string }[];
			return flows.map((flow) => flow.id);
		}

		// Unauthenticated requests and users without a collection-level read permission on
		// directus_flows never see timeline entries.
		if (!this.accountability) {
			throw new ForbiddenError({ reason: `You don't have access to flow runs.` });
		}

		const policies = await fetchPolicies(this.accountability, { schema: this.schema, knex: this.knex });

		const permissions = await fetchPermissions(
			{
				policies,
				accountability: this.accountability,
				action: 'read',
				collections: [FLOWS_TABLE],
			},
			{ schema: this.schema, knex: this.knex },
		);

		if (permissions.length === 0) {
			throw new ForbiddenError({ reason: `You don't have access to flow runs.` });
		}

		// Resolve item-level rules by reading through the FlowsService permission pipeline
		const flowsService = new FlowsService({
			knex: this.knex,
			schema: this.schema,
			accountability: this.accountability,
		});

		const flows = (await flowsService.readByQuery({ fields: ['id'], limit: -1 })) as { id: string }[];

		return flows.map((flow) => flow.id);
	}

	private resolveLimit(rawLimit?: number): number {
		const env = useEnv();
		const max = Number(env['QUERY_LIMIT_MAX'] ?? 100);
		const fallback = Math.min(Number(env['QUERY_LIMIT_DEFAULT'] ?? 100), max > 0 ? max : Number.POSITIVE_INFINITY);

		if (!rawLimit || rawLimit < 1) return fallback;
		if (max > 0) return Math.min(Math.floor(rawLimit), max);
		return Math.floor(rawLimit);
	}
}

function validateStatus(status: string | undefined): (typeof FLOW_RUN_STATUSES)[number] | undefined {
	if (status === undefined) return undefined;

	if (!FLOW_RUN_STATUSES.includes(status as (typeof FLOW_RUN_STATUSES)[number])) {
		throw new InvalidQueryError({
			reason: `Invalid status "${status}". Allowed values are: ${FLOW_RUN_STATUSES.join(', ')}`,
		});
	}

	return status as (typeof FLOW_RUN_STATUSES)[number];
}
