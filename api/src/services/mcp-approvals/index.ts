import crypto from 'node:crypto';
import { useEnv } from '@directus/env';
import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
import type { AbstractServiceOptions, Accountability, SchemaOverview } from '@directus/types';
import { toBoolean } from '@directus/utils';
import type { Knex } from 'knex';
import getDatabase from '../../database/index.js';
import { useLogger } from '../../logger/index.js';
import { fetchRolesTree } from '../../permissions/lib/fetch-roles-tree.js';
import { fetchGlobalAccess } from '../../permissions/modules/fetch-global-access/fetch-global-access.js';
import { validateAccess } from '../../permissions/modules/validate-access/validate-access.js';
import { transaction } from '../../utils/transaction.js';
import {
	type ApprovalMatchContext,
	approvalRoles,
	type ApprovalStatus,
	deriveAction,
	deriveCollection,
	findMatchingPolicy,
	isTerminalStatus,
	maskSensitiveInput,
	TERMINAL_STATUSES,
} from './lib/policy.js';

const POLICIES_TABLE = 'directus_mcp_approval_policies';
const APPROVALS_TABLE = 'directus_mcp_approvals';

/** How long a worker may be "executing" before its claim is considered stale. */
const DEFAULT_EXECUTION_CLAIM_TTL_MS = 2 * 60 * 1000;
const DEFAULT_PENDING_TTL_MINUTES = 60;

export type ApprovalPolicyRow = {
	id: string;
	name: string;
	enabled: boolean;
	oauth_client: string | null;
	role: string | null;
	tool: string | null;
	timeout_minutes: number;
};

export type ApprovalRow = {
	id: string;
	status: ApprovalStatus;
	oauth_client: string | null;
	user: string;
	role: string | null;
	tool: string;
	action: string | null;
	collection: string | null;
	input: Record<string, unknown>;
	input_preview: unknown;
	policy: string | null;
	expires_at: string;
	requested_by: string;
	requested_at: string;
	reviewed_by: string | null;
	reviewed_at: string | null;
	review_note: string | null;
	execution_lock: string | null;
	execution_locked_at: string | null;
	attempts: number;
	completed_at: string | null;
	result: unknown;
	error: string | null;
	request_hash: string;
};

/** Row shape without the canonical input (which never leaves the service). */
export type ApprovalReview = Omit<ApprovalRow, 'input'>;

/** Result of an agent asking the service to gate a concrete tool call. */
export type GateResult =
	| { approved: true }
	| { approved: false; approval: string; status: ApprovalStatus; expiresAt: string };

/** Executor handed to the service so the MCP server owns tool construction/validation. */
export type ApprovalExecutor = (params: {
	name: string;
	args: Record<string, unknown>;
	accountability: Accountability;
	schema: SchemaOverview;
}) => Promise<unknown>;

export type ReviewDecision = 'approve' | 'reject';

type ClaimedApproval = {
	row: ApprovalRow;
	accountability: Accountability;
};

export class McpApprovalsService {
	knex: Knex;
	accountability: Accountability | null;
	schema: SchemaOverview;

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex ?? getDatabase();
		this.accountability = options.accountability ?? null;
		this.schema = options.schema;
	}

	/* ------------------------------------------------------------------ */
	/* Policy matching                                                     */
	/* ------------------------------------------------------------------ */

	async readPolicies(): Promise<ApprovalPolicyRow[]> {
		const rows = await this.knex(POLICIES_TABLE)
			.select(['id', 'name', 'enabled', 'oauth_client', 'role', 'tool', 'timeout_minutes'])
			.orderBy('name', 'asc');

		return rows.map((row) => ({ ...row, enabled: Boolean(row['enabled']) })) as ApprovalPolicyRow[];
	}

	async findPolicyForCall(params: {
		accountability: Accountability;
		tool: string;
		isWrite: boolean;
		args: Record<string, unknown>;
	}): Promise<ApprovalPolicyRow | null> {
		if (toBoolean(useEnv()['MCP_APPROVALS_ENABLED']) !== true) return null;

		const policies = await this.readPolicies();

		const ctx: ApprovalMatchContext = {
			oauthClient: params.accountability.oauth?.client ?? null,
			roles: approvalRoles(params.accountability),
			tool: params.tool,
			isWrite: params.isWrite,
			action: deriveAction(params.args),
		};

		return findMatchingPolicy(policies, ctx);
	}

	/* ------------------------------------------------------------------ */
	/* Agent-facing gate                                                   */
	/* ------------------------------------------------------------------ */

	/**
	 * Gate a write tool call.
	 *
	 * - No matching policy → approved (call runs immediately).
	 * - Identical request already recorded → the existing approval is returned, so a
	 *   replayed request never creates a second pending row or a second execution.
	 * - An expired/cancelled row for the same request is reset to a fresh pending cycle
	 *   (it never executed), still producing exactly one live approval per request.
	 */
	async gateCall(params: {
		accountability: Accountability;
		tool: string;
		args: Record<string, unknown>;
		isWrite: boolean;
	}): Promise<GateResult> {
		const policy = await this.findPolicyForCall(params);

		if (!policy || !params.isWrite) return { approved: true };

		const { accountability, tool, args } = params;

		if (!accountability.user) {
			throw new ForbiddenError({ reason: 'An authenticated user is required for tool approval' });
		}

		const requestHash = hashToolRequest({ accountability, tool, args });
		const { preview } = maskSensitiveInput(args);
		const action = deriveAction(args);
		const collection = deriveCollection(args);
		const now = new Date();
		const expiresAt = new Date(now.getTime() + this.#ttlMs(policy.timeout_minutes));

		try {
			return await transaction(this.knex, async (trx) => {
				// FOR UPDATE serializes concurrent identical replays against this row.
				const existing = await trx<ApprovalRow>(APPROVALS_TABLE)
					.select('*')
					.where({ request_hash: requestHash, user: accountability.user! })
					.orderBy('requested_at', 'desc')
					.first();

				if (existing) {
					const row = parseApprovalRow(existing);

					if (row.status === 'expired' || row.status === 'cancelled') {
						// Never executed: start a new decision cycle on the same audit row.
						const reset: Record<string, unknown> = {
							status: 'pending',
							policy: policy.id,
							expires_at: expiresAt,
							requested_at: now,
							reviewed_by: null,
							reviewed_at: null,
							review_note: null,
							execution_lock: null,
							execution_locked_at: null,
							completed_at: null,
							result: null,
							error: null,
							input: JSON.stringify(args),
							input_preview: JSON.stringify(preview),
							oauth_client: accountability.oauth?.client ?? null,
							role: accountability.role ?? null,
							tool,
							action,
							collection,
						};

						await trx(APPROVALS_TABLE).where('id', row.id).update(reset);

						return {
							approved: false,
							approval: row.id,
							status: 'pending' as ApprovalStatus,
							expiresAt: expiresAt.toISOString(),
						};
					}

					return {
						approved: false,
						approval: row.id,
						status: row.status,
						expiresAt: new Date(row.expires_at).toISOString(),
					};
				}

				const id = crypto.randomUUID();

				await trx(APPROVALS_TABLE).insert(
					this.#insertPayload({
						id,
						status: 'pending',
						accountability,
						tool,
						args,
						preview,
						action,
						collection,
						policyId: policy.id,
						now,
						expiresAt,
						requestHash,
					}),
				);

				useLogger().info(
					{ approval: id, tool, action, collection, client: accountability.oauth?.client ?? null },
					'MCP tool approval requested',
				);

				return {
					approved: false,
					approval: id,
					status: 'pending' as ApprovalStatus,
					expiresAt: expiresAt.toISOString(),
				};
			});
		} catch (error) {
			// Concurrent first-time replays: the unique (request_hash, user) constraint means
			// the losing transaction sees the winner's row -- return it instead of erroring.
			if (isUniqueViolation(error)) {
				const winner = await this.knex<ApprovalRow>(APPROVALS_TABLE)
					.select('*')
					.where({ request_hash: requestHash, user: accountability.user! })
					.first();

				if (winner) {
					const row = parseApprovalRow(winner);
					return {
						approved: false,
						approval: row.id,
						status: row.status === 'expired' || row.status === 'cancelled' ? 'pending' : row.status,
						expiresAt: new Date(row.expires_at).toISOString(),
					};
				}
			}

			throw error;
		}
	}

	#insertPayload(data: {
		id: string;
		status: ApprovalStatus;
		accountability: Accountability;
		tool: string;
		args: Record<string, unknown>;
		preview: unknown;
		action: string | null;
		collection: string | null;
		policyId: string;
		now: Date;
		expiresAt: Date;
		requestHash: string;
	}): Record<string, unknown> {
		return {
			id: data.id,
			status: data.status,
			oauth_client: data.accountability.oauth?.client ?? null,
			user: data.accountability.user,
			role: data.accountability.role ?? null,
			tool: data.tool,
			action: data.action,
			collection: data.collection,
			input: JSON.stringify(data.args),
			input_preview: JSON.stringify(data.preview),
			policy: data.policyId,
			expires_at: data.expiresAt,
			requested_by: data.accountability.user,
			requested_at: data.now,
			request_hash: data.requestHash,
		};
	}

	/**
	 * Status as seen by the requesting agent (polling). Ownership is enforced: an agent
	 * may only inspect its own approvals. Pending rows past their deadline are expired
	 * lazily on read. The canonical input is never returned.
	 */
	async getForAgent(
		id: string,
		accountability: Accountability,
	): Promise<{
		id: string;
		status: ApprovalStatus;
		tool: string;
		action: string | null;
		collection: string | null;
		expires_at: string;
		result?: unknown;
		error?: string | null;
	}> {
		const raw = await this.knex<ApprovalRow>(APPROVALS_TABLE)
			.select('*')
			.where({ id, user: accountability.user ?? '' })
			.first();

		if (!raw) throw new ForbiddenError();

		const row = parseApprovalRow(raw);

		if (row.status === 'pending' && new Date(row.expires_at) <= new Date()) {
			await this.knex(APPROVALS_TABLE).where({ id, status: 'pending' }).update({ status: 'expired' });
			row.status = 'expired';
		} else if (row.status === 'pending' && (await this.#cancelIfOrphaned(row))) {
			row.status = 'cancelled';
		}

		return {
			id: row.id,
			status: row.status,
			tool: row.tool,
			action: row.action,
			collection: row.collection,
			expires_at: row.expires_at,
			...(row.status === 'completed' && { result: parseJsonLoose(row.result) }),
			...(row.status === 'failed' && { error: row.error }),
		};
	}

	/* ------------------------------------------------------------------ */
	/* Reviewer-facing actions                                             */
	/* ------------------------------------------------------------------ */

	/**
	 * List approvals for the approval center. Non-admin reviewers only see rows whose
	 * target action they are themselves allowed to perform; admins see everything.
	 * Canonical inputs are stripped, only masked previews remain.
	 */
	async listForReview(query: { status?: ApprovalStatus | null } = {}): Promise<ApprovalReview[]> {
		this.#requireReviewer();

		// Opportunistically revoke pending rows whose OAuth grant disappeared.
		if (!query.status || query.status === 'pending') {
			await this.cancelOrphanedGrants();
		}

		const builder = this.knex(APPROVALS_TABLE).select('*').orderBy('requested_at', 'desc');

		if (query.status) {
			builder.where('status', query.status);
		}

		const rows = (await builder) as Record<string, unknown>[];
		const parsed = rows.map((row) => parseApprovalRow(row));

		if (this.accountability?.admin === true) return parsed.map((row) => this.#toReview(row));

		const visible: ApprovalReview[] = [];

		for (const row of parsed) {
			if (await this.#reviewerCanReview(row)) visible.push(this.#toReview(row));
		}

		return visible;
	}

	async getForReview(id: string): Promise<ApprovalReview | null> {
		this.#requireReviewer();

		const raw = await this.knex(APPROVALS_TABLE).select('*').where('id', id).first();

		if (!raw) return null;

		const row = parseApprovalRow(raw);

		if (this.accountability?.admin !== true && !(await this.#reviewerCanReview(row))) {
			throw new ForbiddenError({ reason: 'You do not have permission to view this approval' });
		}

		return this.#toReview(row);
	}

	/**
	 * Review an approval.
	 *
	 * approve: the pending row is compare-and-swapped to "executing" inside a row-locked
	 * transaction; after commit the original tool runs exactly once with the rebuilt
	 * requester accountability; the terminal status (completed/failed/cancelled) is then
	 * recorded under the same execution lock. Concurrent clicks find a non-pending row
	 * and return it without executing.
	 */
	async review(
		id: string,
		decision: ReviewDecision,
		options: { note?: string | null; execute: ApprovalExecutor },
	): Promise<ApprovalReview> {
		this.#requireReviewer();

		const claimed = await transaction(this.knex, async (trx) => {
			// The conditional status updates below are the compare-and-swap that guarantees
			// exactly one execution. Relying on the CAS (rather than SELECT ... FOR UPDATE)
			// keeps the path portable across MySQL/SQLite and works under all isolation levels.
			const raw = await trx(APPROVALS_TABLE).select('*').where('id', id).first();

			if (!raw) throw new InvalidPayloadError({ reason: 'Approval does not exist' });

			const row = parseApprovalRow(raw);

			if (row.status !== 'pending') {
				// Already processed (concurrent click / replay): return as-is, never execute.
				return { kind: 'done' as const, review: this.#toReview(row) };
			}

			if (new Date(row.expires_at) <= new Date()) {
				await trx(APPROVALS_TABLE).where('id', id).update({ status: 'expired', completed_at: new Date() });
				return { kind: 'expired' as const };
			}

			if (this.accountability?.admin !== true && !(await this.#reviewerCanReview(row, trx))) {
				throw new ForbiddenError({ reason: 'You do not have permission to approve this tool call' });
			}

			if (decision === 'reject') {
				await trx(APPROVALS_TABLE)
					.where('id', id)
					.update({
						status: 'rejected',
						reviewed_by: this.accountability!.user,
						reviewed_at: new Date(),
						review_note: options.note ?? null,
						completed_at: new Date(),
					});

				useLogger().info({ approval: id, reviewed_by: this.accountability!.user }, 'MCP tool approval rejected');

				return {
					kind: 'done' as const,
					review: this.#toReview({ ...row, status: 'rejected', reviewed_by: this.accountability!.user }),
				};
			}

			// Approve: claim the execution atomically. The conditional update is the
			// compare-and-swap that guarantees exactly one execution.
			const lockToken = crypto.randomUUID();
			const now = new Date();

			const claimedCount = await trx(APPROVALS_TABLE)
				.where('id', id)
				.where('status', 'pending')
				.update({
					status: 'executing',
					execution_lock: lockToken,
					execution_locked_at: now,
					attempts: trx.raw('attempts + 1'),
					reviewed_by: this.accountability!.user,
					reviewed_at: now,
					review_note: options.note ?? null,
				});

			if (updateCount(claimedCount) === 0) {
				// Lost a race despite the lock: never execute.
				return { kind: 'done' as const, review: this.#toReview(row) };
			}

			const accountability = await this.#rebuildAccountability(row, trx);

			if (!accountability) {
				// User deleted/deactivated or OAuth grant revoked between request and approval.
				await trx(APPROVALS_TABLE).where('id', id).where('execution_lock', lockToken).update({
					status: 'cancelled',
					completed_at: new Date(),
					error: 'Requester or OAuth grant is no longer valid',
					execution_lock: null,
				});

				return {
					kind: 'done' as const,
					review: this.#toReview({ ...row, status: 'cancelled', reviewed_by: this.accountability!.user }),
				};
			}

			useLogger().info({ approval: id, reviewed_by: this.accountability!.user }, 'MCP tool approval approved');

			const claimed: ClaimedApproval = {
				row: { ...row, status: 'executing', execution_lock: lockToken },
				accountability,
			};

			return { kind: 'claim' as const, claim: claimed };
		});

		if (claimed.kind === 'expired') {
			throw new InvalidPayloadError({ reason: 'Approval has expired' });
		}

		if (claimed.kind === 'done') return claimed.review;

		// Execute AFTER commit. The tool's own writes are independent; at-most-once is
		// guaranteed by the locked "executing" row, so crashes/DB failures never trigger a
		// second attempt.
		const { row, accountability } = claimed.claim;
		const terminalStatus = await this.#runClaimed(row, accountability, options.execute);

		const finalRaw = await this.knex(APPROVALS_TABLE).select('*').where('id', row.id).first();
		const finalRow = parseApprovalRow(finalRaw);

		// Fail closed: if what we persisted/read does not match the expected terminal state,
		// surface an error rather than reporting success -- the row will never be re-executed.
		if (finalRow.status !== terminalStatus) {
			throw new Error(`Approval ${row.id} did not reach expected terminal state "${terminalStatus}"`);
		}

		return this.#toReview(finalRow);
	}

	/* ------------------------------------------------------------------ */
	/* Revocation / expiry                                                 */
	/* ------------------------------------------------------------------ */

	/**
	 * Cancel every still-pending approval for an OAuth grant (revocation / refresh-token
	 * replay). Approved/executing rows are deliberately not touched: an already-approved
	 * call re-checks the grant at execution time (in #rebuildAccountability and again via
	 * the executor's accountability), and cancelling an executing row could not un-execute
	 * its side effects.
	 */
	async cancelForGrant(client: string, user: string, trx?: Knex | Knex.Transaction): Promise<number> {
		const db = trx ?? this.knex;

		const count = await db(APPROVALS_TABLE)
			.where({ oauth_client: client, user, status: 'pending' })
			.update({ status: 'cancelled', completed_at: new Date() });

		if (count > 0) {
			useLogger().info({ client, user, count }, 'Pending MCP approvals cancelled after token revocation');
		}

		return count;
	}

	/**
	 * Expire pending approvals past their deadline. Idempotent: the conditional update
	 * never touches decided rows, so real-time/poll retries cannot re-execute anything.
	 */
	async expireDue(now: Date = new Date()): Promise<number> {
		return updateCount(
			await this.knex(APPROVALS_TABLE)
				.where('status', 'pending')
				.andWhere('expires_at', '<=', now)
				.update({ status: 'expired', completed_at: now }),
		);
	}

	/**
	 * Recover rows stuck in "executing" past the claim TTL (worker crashed or lost the
	 * database while executing). Marked failed and NEVER retried: re-running an
	 * unknown-outcome write could double-apply it.
	 */
	async recoverStaleClaims(now: Date = new Date()): Promise<number> {
		const ttlMs = this.#claimTtlMs();

		const stale = await this.knex<{ id: string }>(APPROVALS_TABLE)
			.select('id')
			.where('status', 'executing')
			.andWhere('execution_locked_at', '<=', new Date(now.getTime() - ttlMs));

		if (stale.length === 0) return 0;

		return updateCount(
			await this.knex(APPROVALS_TABLE)
				.whereIn(
					'id',
					stale.map((row) => row.id),
				)
				.where('status', 'executing')
				.update({
					status: 'failed',
					completed_at: now,
					execution_lock: null,
					error: 'Execution outcome unknown: worker stopped responding. The request was not retried.',
				}),
		);
	}

	/**
	 * Cancel pending OAuth-backed approvals whose grant (client+user) no longer exists --
	 * the token was revoked or detected as replayed. Runs from the cleanup schedule and
	 * lazily while listing; the real safety boundary is the grant re-check at execution
	 * time, so a missing cancel update can never cause a side effect.
	 */
	async cancelOrphanedGrants(): Promise<number> {
		const orphaned = await this.knex(APPROVALS_TABLE)
			.distinct(`${APPROVALS_TABLE}.id`)
			.leftJoin('directus_oauth_tokens', function () {
				this.on(`${APPROVALS_TABLE}.oauth_client`, '=', 'directus_oauth_tokens.client').andOn(
					`${APPROVALS_TABLE}.user`,
					'=',
					'directus_oauth_tokens.user',
				);
			})
			.where(`${APPROVALS_TABLE}.status`, 'pending')
			.whereNotNull(`${APPROVALS_TABLE}.oauth_client`)
			.whereNull('directus_oauth_tokens.id')
			.pluck(`${APPROVALS_TABLE}.id`);

		if (orphaned.length === 0) return 0;

		return updateCount(
			await this.knex(APPROVALS_TABLE).whereIn('id', orphaned).where('status', 'pending').update({
				status: 'cancelled',
				completed_at: new Date(),
				error: 'OAuth grant revoked before approval',
			}),
		);
	}

	/**
	 * Cancel a pending OAuth-backed approval on demand if its grant is gone. Used on the
	 * agent polling path so a revoked-token request resolves to "cancelled" immediately
	 * instead of lingering until the next cleanup run.
	 */
	async #cancelIfOrphaned(row: ApprovalRow): Promise<boolean> {
		if (!row.oauth_client) return false;

		const grant = await this.knex('directus_oauth_tokens')
			.select('id')
			.where({ client: row.oauth_client, user: row.user })
			.first();

		if (grant) return false;

		await this.knex(APPROVALS_TABLE).where('id', row.id).where('status', 'pending').update({
			status: 'cancelled',
			completed_at: new Date(),
			error: 'OAuth grant revoked before approval',
		});

		return true;
	}

	/** Maintenance hook used by the cleanup schedule: expire, recover, orphan-cancel. */
	async cleanup(): Promise<{ expired: number; recovered: number; orphaned: number }> {
		const now = new Date();
		const expired = await this.expireDue(now);
		const recovered = await this.recoverStaleClaims(now);
		const orphaned = await this.cancelOrphanedGrants();

		return { expired, recovered, orphaned };
	}

	/* ------------------------------------------------------------------ */
	/* Internal                                                            */
	/* ------------------------------------------------------------------ */

	/**
	 * Run the tool for an already-claimed approval exactly once and persist the terminal
	 * status. Every status update is scoped to the row's execution lock, so a stale-claim
	 * recovery that fired concurrently cannot be overwritten by a late completion.
	 *
	 * Failure handling is fail-closed:
	 * - executor throws: try to persist "failed" (never retried); if that update also fails,
	 *   the row stays locked in "executing" until the TTL recovery marks it failed -- the
	 *   tool itself is NEVER invoked a second time.
	 * - terminal-status persistence itself fails: same rule -- do not re-run, surface the
	 *   error, rely on TTL recovery.
	 */
	async #runClaimed(
		row: ApprovalRow,
		accountability: Accountability,
		execute: ApprovalExecutor,
	): Promise<ApprovalStatus> {
		const lockToken = row.execution_lock!;

		let executionError: Error | null = null;
		let result: unknown = undefined;

		try {
			result = await execute({
				name: row.tool,
				args: row.input,
				accountability,
				schema: this.schema,
			});
		} catch (error) {
			executionError = error instanceof Error ? error : new Error('Tool execution failed');
			useLogger().error({ approval: row.id, err: error }, 'MCP approved tool execution failed');
		}

		if (executionError) {
			const persisted = await this.#persistTerminal(row.id, lockToken, {
				status: 'failed',
				error: executionError.message,
				completed_at: new Date(),
				execution_lock: null,
			});

			if (!persisted) {
				// The failure record could not be written. Fail closed: leave the row locked in
				// "executing" (TTL recovery resolves it) and surface the error; never re-run.
				throw new Error(`Failed to persist terminal status for approval ${row.id}: ${executionError.message}`);
			}

			return 'failed';
		}

		const completed = await this.#persistTerminal(row.id, lockToken, {
			status: 'completed',
			result: JSON.stringify(result ?? null),
			completed_at: new Date(),
			execution_lock: null,
		});

		if (!completed) {
			// The tool already ran (possibly with side effects) but the outcome could not be
			// recorded. At-most-once wins: throw, do not re-run; TTL recovery marks it failed.
			throw new Error(`Failed to persist completed status for approval ${row.id}`);
		}

		useLogger().info({ approval: row.id, tool: row.tool }, 'MCP tool approval executed');

		return 'completed';
	}

	/**
	 * Write a terminal status under the row's execution lock. Returns true when this call
	 * moved the "executing" row to its terminal state, false when the update did not apply
	 * (database failure or the row was recovered by another worker). The fallback records
	 * `failed` so a persistence outage still resolves to a terminal, non-replayable state.
	 */
	async #persistTerminal(id: string, lockToken: string, payload: Record<string, unknown>): Promise<boolean> {
		try {
			const affected = updateCount(
				await this.knex(APPROVALS_TABLE)
					.where('id', id)
					.where('execution_lock', lockToken)
					.where('status', 'executing')
					.update(payload),
			);

			if (affected > 0) return true;

			// The conditional update matched nothing. Two cases:
			// 1) stale-claim recovery already resolved it -- nothing to do;
			// 2) lock/status mismatch for another reason -- treat as persistence failure.
			const current = await this.knex(APPROVALS_TABLE)
				.select(['id', 'status', 'execution_lock'])
				.where('id', id)
				.first();

			const currentRow = current as { status: string; execution_lock: string | null } | undefined;

			if (currentRow && currentRow.status !== 'executing') {
				// Already terminal (e.g. recovered). Respect that and do not overwrite.
				return true;
			}

			return false;
		} catch (error) {
			useLogger().error(
				{ approval: id, err: error },
				'MCP approval terminal-status persistence failed; row will be recovered by TTL',
			);

			return false;
		}
	}

	/**
	 * Rebuild the original requester's accountability at execution time. Returns null
	 * when the user was deleted/deactivated or -- for OAuth sessions -- their grant no
	 * longer exists (revoked). Roles and global access are recomputed so permission and
	 * role changes take effect immediately.
	 */
	async #rebuildAccountability(row: ApprovalRow, db: Knex | Knex.Transaction): Promise<Accountability | null> {
		const user = await db('directus_users').select(['id', 'role', 'status']).where('id', row.user).first();

		if (!user || user['status'] !== 'active') return null;

		if (row.oauth_client) {
			const grant = await db('directus_oauth_tokens')
				.select('id')
				.where({ client: row.oauth_client, user: row.user })
				.first();

			if (!grant) return null;
		}

		const accountability: Accountability = {
			user: user['id'],
			role: user['role'],
			roles: await fetchRolesTree(user['role'], { knex: db as Knex }),
			admin: false,
			app: false,
			ip: null,
			...(row.oauth_client ? { oauth: { client: row.oauth_client, scopes: [], aud: [] } } : {}),
		};

		const { admin, app } = await fetchGlobalAccess(accountability, { knex: db as Knex });
		accountability.admin = admin;
		accountability.app = app;

		return accountability;
	}

	/** Check whether the current reviewer may approve a concrete request. */
	async #reviewerCanReview(row: ApprovalRow, db: Knex | Knex.Transaction = this.knex): Promise<boolean> {
		if (!this.accountability?.user) return false;

		// Writes without a derivable target collection can only be approved by admins.
		if (!row.collection) return false;

		const action = (row.action === 'read' ? 'read' : (row.action ?? 'update')) as
			| 'create'
			| 'read'
			| 'update'
			| 'delete';

		try {
			await validateAccess(
				{
					accountability: this.accountability,
					action,
					collection: row.collection,
					skipCollectionExistsCheck: true,
				},
				{ knex: db as Knex, schema: this.schema, accountability: this.accountability },
			);

			return true;
		} catch {
			return false;
		}
	}

	#requireReviewer(): void {
		if (!this.accountability?.user) {
			throw new ForbiddenError({ reason: 'Authentication is required for the approval center' });
		}
	}

	#toReview(row: ApprovalRow): ApprovalReview {
		const { input: _input, ...safe } = row;
		return safe;
	}

	#ttlMs(timeoutMinutes: number): number {
		const minutes =
			Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes : DEFAULT_PENDING_TTL_MINUTES;

		return minutes * 60 * 1000;
	}

	#claimTtlMs(): number {
		const envValue = Number(useEnv()['MCP_APPROVAL_EXECUTION_CLAIM_TTL_MS']);
		return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_EXECUTION_CLAIM_TTL_MS;
	}
}

/** Normalize a raw database row (JSON columns may be strings depending on the driver). */
function parseApprovalRow(raw: Record<string, unknown>): ApprovalRow {
	return {
		...(raw as unknown as ApprovalRow),
		input: parseJsonLoose(raw['input']) as Record<string, unknown>,
		input_preview: parseJsonLoose(raw['input_preview']),
		result: parseJsonLoose(raw['result']),
		attempts: Number(raw['attempts'] ?? 0),
	};
}

function parseJsonLoose(value: unknown): unknown {
	if (typeof value !== 'string') return value;

	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** knex update result normalization across drivers (affected count vs client-specific shapes). */
function updateCount(result: unknown): number {
	if (typeof result === 'number') return result;
	if (Array.isArray(result)) return result.length;

	if (result && typeof result === 'object' && 'rowCount' in result) {
		return Number((result as { rowCount?: number }).rowCount ?? 0);
	}

	return 0;
}

function isUniqueViolation(error: unknown): boolean {
	if (error === null || typeof error !== 'object') return false;

	const code = String((error as { code?: unknown }).code ?? '');

	const constraint = String(
		(error as { constraint?: unknown; message?: unknown }).constraint ?? (error as { message?: unknown }).message ?? '',
	);

	// postgres/cockroach 23505, mysql ER_DUP_ENTRY (1062), sqlite SQLITE_CONSTRAINT_UNIQUE (19/2067),
	// oracle ORA-00001, mssql 2627/2601.
	return (
		code === '23505' ||
		code === 'ER_DUP_ENTRY' ||
		code === 'SQLITE_CONSTRAINT_UNIQUE' ||
		code === '19' ||
		code === '2627' ||
		code === '2601' ||
		/ORA-00001/.test(constraint) ||
		/unique constraint/i.test(constraint)
	);
}

/**
 * Stable hash of the canonical request: requester, OAuth client, tool name and exact
 * validated arguments. Identical write calls from the same session collapse onto a
 * single approval; any argument change produces a distinct approval.
 */
export function hashToolRequest(params: {
	accountability: Accountability;
	tool: string;
	args: Record<string, unknown>;
}): string {
	const payload = JSON.stringify({
		client: params.accountability.oauth?.client ?? null,
		user: params.accountability.user,
		tool: params.tool,
		args: params.args,
	});

	return crypto.createHash('sha256').update(payload).digest('hex');
}

export { APPROVALS_TABLE, isTerminalStatus, POLICIES_TABLE, TERMINAL_STATUSES };
