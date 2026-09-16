import { ForbiddenError, InvalidPayloadError } from '@directus/errors';
import { SchemaBuilder } from '@directus/schema-builder';
import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ApprovalRow, McpApprovalsService } from './index.js';

vi.mock('../../database/index.js', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

vi.mock('@directus/env', () => ({
	useEnv: vi.fn().mockReturnValue({
		MCP_APPROVALS_ENABLED: true,
		MCP_APPROVAL_EXECUTION_CLAIM_TTL_MS: 120000,
	}),
}));

vi.mock('../../logger/index.js', () => ({
	useLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockValidateAccess = vi.fn();

vi.mock('../../permissions/modules/validate-access/validate-access.js', () => ({
	validateAccess: (...args: unknown[]) => mockValidateAccess(...args),
}));

vi.mock('../../permissions/lib/fetch-roles-tree.js', () => ({
	fetchRolesTree: vi.fn().mockResolvedValue(['role-1']),
}));

vi.mock('../../permissions/modules/fetch-global-access/fetch-global-access.js', () => ({
	fetchGlobalAccess: vi.fn().mockResolvedValue({ admin: false, app: true }),
}));

const schema = new SchemaBuilder()
	.collection('articles', (c) => {
		c.field('id').uuid().primary();
	})
	.build();

const agent = {
	user: 'user-1',
	role: 'role-1',
	roles: ['role-1'],
	admin: false,
	app: true,
	ip: null,
	oauth: { client: 'client-a', scopes: ['mcp:access'], aud: ['https://example.com/mcp'] },
};

const reviewer = {
	user: 'reviewer-1',
	role: 'reviewer-role',
	roles: ['reviewer-role'],
	admin: false,
	app: true,
	ip: null,
};

const writeArgs = { collection: 'articles', action: 'create', data: { title: 'Hello' } };

const policy = {
	id: 'policy-1',
	name: 'All writes',
	enabled: true,
	oauth_client: null,
	role: null,
	tool: 'write',
	timeout_minutes: 60,
};

type RawApprovalOverrides = Partial<Omit<ApprovalRow, 'input' | 'input_preview' | 'result'>> & {
	input?: unknown;
	input_preview?: unknown;
	result?: unknown;
};

function makeApprovalRow(overrides: RawApprovalOverrides = {}): ApprovalRow {
	return {
		id: 'approval-1',
		status: 'pending',
		oauth_client: 'client-a',
		user: 'user-1',
		role: 'role-1',
		tool: 'items',
		action: 'create',
		collection: 'articles',
		input: { ...writeArgs },
		input_preview: { ...writeArgs },
		policy: 'policy-1',
		expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
		requested_by: 'user-1',
		requested_at: new Date().toISOString(),
		reviewed_by: null,
		reviewed_at: null,
		review_note: null,
		execution_lock: null,
		execution_locked_at: null,
		attempts: 0,
		completed_at: null,
		result: null,
		error: null,
		request_hash: 'hash-1',
		...overrides,
	} as ApprovalRow;
}

describe('Services / McpApprovalsService', () => {
	let db: ReturnType<typeof knex.default>;
	let tracker: Tracker;

	beforeEach(() => {
		db = knex.default({ client: MockClient });
		tracker = createTracker(db);
		mockValidateAccess.mockReset();
		mockValidateAccess.mockResolvedValue(undefined);
	});

	afterEach(() => {
		tracker.reset();
		vi.clearAllMocks();
	});

	describe('gateCall', () => {
		it('runs immediately when no policy matches', async () => {
			tracker.on.select('directus_mcp_approval_policies').response([]);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const result = await service.gateCall({ accountability: agent, tool: 'items', args: writeArgs, isWrite: true });

			expect(result).toEqual({ approved: true });
		});

		it('creates a pending approval for a matched write', async () => {
			tracker.on.select('directus_mcp_approval_policies').response([policy]);
			tracker.on.select('directus_mcp_approvals').response([]);
			tracker.on.insert('directus_mcp_approvals').response([]);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const result = await service.gateCall({ accountability: agent, tool: 'items', args: writeArgs, isWrite: true });

			expect(result.approved).toBe(false);
			if (result.approved) throw new Error('expected gated result');
			expect(result.status).toBe('pending');

			const insert = tracker.history.insert.find((q) => q.sql.includes('directus_mcp_approvals'));
			expect(insert).toBeTruthy();

			const jsonBindings = (insert!.bindings as unknown[])
				.filter((b): b is string => typeof b === 'string' && b.startsWith('{'))
				.map((b) => {
					try {
						return JSON.parse(b);
					} catch {
						return null;
					}
				});

			// input JSON
			expect(jsonBindings).toContainEqual(expect.objectContaining({ collection: 'articles', action: 'create' }));
		});

		it('reuses an in-flight approval for an identical request instead of inserting again', async () => {
			tracker.on.select('directus_mcp_approval_policies').response([policy]);

			tracker.on
				.select('directus_mcp_approvals')
				.response([makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) })]);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const result = await service.gateCall({ accountability: agent, tool: 'items', args: writeArgs, isWrite: true });

			expect(result).toMatchObject({ approved: false, approval: 'approval-1', status: 'pending' });
			expect(tracker.history.insert.filter((q) => q.sql.includes('directus_mcp_approvals'))).toHaveLength(0);
		});

		it('returns the completed approval on replay -- it can never execute twice', async () => {
			tracker.on.select('directus_mcp_approval_policies').response([policy]);

			tracker.on
				.select('directus_mcp_approvals')
				.response([makeApprovalRow({ status: 'completed', result: JSON.stringify({ id: 'x' }) })]);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const result = await service.gateCall({ accountability: agent, tool: 'items', args: writeArgs, isWrite: true });

			expect(result).toMatchObject({ approved: false, approval: 'approval-1', status: 'completed' });
		});

		it('resets an expired row to a fresh pending cycle without a second row', async () => {
			tracker.on.select('directus_mcp_approval_policies').response([policy]);

			tracker.on
				.select('directus_mcp_approvals')
				.response([makeApprovalRow({ status: 'expired', expires_at: new Date(Date.now() - 1000).toISOString() })]);

			tracker.on.update('directus_mcp_approvals').response(1);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const result = await service.gateCall({ accountability: agent, tool: 'items', args: writeArgs, isWrite: true });

			expect(result).toMatchObject({ approved: false, status: 'pending' });
			const updates = tracker.history.update.filter((q) => q.sql.includes('directus_mcp_approvals'));
			expect(updates.length).toBeGreaterThan(0);
			expect(tracker.history.insert.filter((q) => q.sql.includes('directus_mcp_approvals'))).toHaveLength(0);
		});

		it('fails closed when the pending approval cannot be inserted -- the write is blocked', async () => {
			tracker.on.select('directus_mcp_approval_policies').response([policy]);
			tracker.on.select('directus_mcp_approvals').response([]);
			tracker.on.insert('directus_mcp_approvals').simulateError(new Error('connection lost'));

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });

			// A database failure creating the approval must reject: callers never proceed to run
			// the write on an unrecorded approval.
			await expect(
				service.gateCall({ accountability: agent, tool: 'items', args: writeArgs, isWrite: true }),
			).rejects.toThrow();

			// Exactly one insert attempt -- no retry loop.
			const inserts = tracker.history.insert.filter((q) => q.sql.includes('directus_mcp_approvals'));
			expect(inserts).toHaveLength(1);
		});
	});

	describe('getForAgent', () => {
		it('forbids reading approvals owned by another user', async () => {
			tracker.on.select('directus_mcp_approvals').response([]);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			await expect(service.getForAgent('approval-1', agent)).rejects.toBeInstanceOf(ForbiddenError);
		});

		it('expires a due pending row lazily on poll', async () => {
			tracker.on
				.select('directus_mcp_approvals')
				.response([makeApprovalRow({ status: 'pending', expires_at: new Date(Date.now() - 1000).toISOString() })]);

			tracker.on.update('directus_mcp_approvals').response(1);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const status = await service.getForAgent('approval-1', agent);

			expect(status.status).toBe('expired');
			expect(tracker.history.update.length).toBeGreaterThan(0);
		});

		it('never returns the canonical input', async () => {
			tracker.on
				.select('directus_mcp_approvals')
				.response([makeApprovalRow({ status: 'completed', result: JSON.stringify({ ok: true }) })]);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const status = await service.getForAgent('approval-1', agent);

			expect(status).not.toHaveProperty('input');
			expect(status).not.toHaveProperty('input_preview');
		});
	});

	describe('review', () => {
		function setupApproval(row: ApprovalRow) {
			// select ... for update inside transaction
			tracker.on.select('directus_mcp_approvals').response([row]);
		}

		it('executes the original tool exactly once on approve and records the result', async () => {
			tracker.on.update('directus_mcp_approvals').response(1);
			tracker.on.select('directus_users').response([{ id: 'user-1', role: 'role-1', status: 'active' }]);
			tracker.on.select('directus_oauth_tokens').response([{ id: 'grant-1' }]);

			// The first approvals select (inside the review tx) returns the pending row; the
			// final post-execution read returns the completed row.
			let approvalsReads = 0;

			tracker.on.select('directus_mcp_approvals').response(() => {
				approvalsReads += 1;
				return approvalsReads <= 1
					? [makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) })]
					: [makeApprovalRow({ status: 'completed', result: JSON.stringify({ id: 'new-item' }) })];
			});

			const executor = vi.fn().mockResolvedValue({ id: 'new-item' });
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			const result = await service.review('approval-1', 'approve', { execute: executor });

			expect(executor).toHaveBeenCalledTimes(1);
			const call = executor.mock.calls[0]![0];
			expect(call.name).toBe('items');
			expect(call.args).toEqual(writeArgs);
			// Executes as the original requester, not the reviewer.
			expect(call.accountability.user).toBe('user-1');

			const completion = tracker.history.update.find((q) => String(q.bindings).includes('completed'));
			expect(completion).toBeTruthy();
			expect(result.status).toBe('completed');
		});

		it('does not execute when rejecting', async () => {
			setupApproval(makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) }));
			tracker.on.update('directus_mcp_approvals').response(1);

			const executor = vi.fn();
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			const result = await service.review('approval-1', 'reject', { note: 'no thanks', execute: executor });

			expect(executor).not.toHaveBeenCalled();
			expect(result.status).toBe('rejected');
			expect(tracker.history.update.some((q) => String(q.bindings).includes('rejected'))).toBe(true);
		});

		it('concurrent second click on an approved row returns it without executing again', async () => {
			setupApproval(
				makeApprovalRow({
					status: 'executing',
					execution_lock: 'lock-1',
					input: JSON.stringify(writeArgs),
					input_preview: JSON.stringify(writeArgs),
				}),
			);

			const executor = vi.fn();
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			const result = await service.review('approval-1', 'approve', { execute: executor });

			expect(executor).not.toHaveBeenCalled();
			expect(result.status).toBe('executing');
		});

		it('refuses to approve an expired pending approval', async () => {
			setupApproval(
				makeApprovalRow({
					expires_at: new Date(Date.now() - 1000).toISOString(),
					input: JSON.stringify(writeArgs),
					input_preview: JSON.stringify(writeArgs),
				}),
			);

			tracker.on.update('directus_mcp_approvals').response(1);

			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			await expect(service.review('approval-1', 'approve', { execute: vi.fn() })).rejects.toBeInstanceOf(
				InvalidPayloadError,
			);
		});

		it('requires the reviewer to hold the target permission; a forbidden reviewer cannot approve', async () => {
			setupApproval(makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) }));
			mockValidateAccess.mockRejectedValueOnce(new ForbiddenError());

			const service = new McpApprovalsService({ knex: db, accountability: reviewer, schema });

			await expect(service.review('approval-1', 'approve', { execute: vi.fn() })).rejects.toBeInstanceOf(
				ForbiddenError,
			);

			expect(mockValidateAccess).toHaveBeenCalledWith(
				expect.objectContaining({ action: 'create', collection: 'articles' }),
				expect.anything(),
			);
		});

		it('marks the approval failed and never retries when the tool throws', async () => {
			tracker.on.update('directus_mcp_approvals').response(1);
			tracker.on.select('directus_users').response([{ id: 'user-1', role: 'role-1', status: 'active' }]);
			tracker.on.select('directus_oauth_tokens').response([{ id: 'grant-1' }]);

			let approvalsReads = 0;

			tracker.on.select('directus_mcp_approvals').response(() => {
				approvalsReads += 1;
				return approvalsReads <= 1
					? [makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) })]
					: [makeApprovalRow({ status: 'failed', error: 'boom' })];
			});

			const executor = vi.fn().mockRejectedValue(new Error('boom'));
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			const result = await service.review('approval-1', 'approve', { execute: executor });

			expect(executor).toHaveBeenCalledTimes(1);
			expect(result.status).toBe('failed');
			expect(result.error).toBe('boom');
			expect(tracker.history.update.some((q) => String(q.bindings).includes('failed'))).toBe(true);
		});

		it('cancels instead of executing when the requester oauth grant is gone (revoked token)', async () => {
			setupApproval(makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) }));
			tracker.on.update('directus_mcp_approvals').response(1);
			tracker.on.select('directus_users').response([{ id: 'user-1', role: 'role-1', status: 'active' }]);
			tracker.on.select('directus_oauth_tokens').response([]);

			const executor = vi.fn();
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			const result = await service.review('approval-1', 'approve', { execute: executor });

			expect(executor).not.toHaveBeenCalled();
			expect(result.status).toBe('cancelled');
		});

		it('cancels when the requester user is no longer active', async () => {
			setupApproval(
				makeApprovalRow({
					oauth_client: null,
					input: JSON.stringify(writeArgs),
					input_preview: JSON.stringify(writeArgs),
				}),
			);

			tracker.on.update('directus_mcp_approvals').response(1);
			tracker.on.select('directus_users').response([{ id: 'user-1', role: 'role-1', status: 'suspended' }]);

			const executor = vi.fn();
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			const result = await service.review('approval-1', 'approve', { execute: executor });

			expect(executor).not.toHaveBeenCalled();
			expect(result.status).toBe('cancelled');
		});

		it('fails closed when the claim UPDATE fails -- executor never runs and no retry happens', async () => {
			setupApproval(makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) }));
			// The claim transaction blows up (deadlock / connection loss): the update rejects,
			// rolling the transaction back so the row stays pending.
			tracker.on.update('directus_mcp_approvals').simulateError(new Error('deadlock detected'));

			const executor = vi.fn();
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			await expect(service.review('approval-1', 'approve', { execute: executor })).rejects.toThrow();

			expect(executor).not.toHaveBeenCalled();
			// The claim attempt is single-shot: no automatic retry.
			const claimUpdates = tracker.history.update.filter((q) => q.sql.includes('directus_mcp_approvals'));
			expect(claimUpdates).toHaveLength(1);
			expect(claimUpdates[0]!.bindings).toContain('executing');
		});

		it('completed persistence failure leaves the tool un-re-run: fail closed, TTL recovery applies', async () => {
			setupApproval(makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) }));
			tracker.on.select('directus_users').response([{ id: 'user-1', role: 'role-1', status: 'active' }]);
			tracker.on.select('directus_oauth_tokens').response([{ id: 'grant-1' }]);

			// Handlers match in registration order: first UPDATE (the claim) succeeds,
			// the second (completed persistence) fails once and is removed.
			tracker.on.update('directus_mcp_approvals').response(1);
			tracker.on.update('directus_mcp_approvals').simulateErrorOnce(new Error('write unavailable'));

			// Post-execution read returns the still-locked row.
			tracker.on
				.select('directus_mcp_approvals')
				.response([makeApprovalRow({ status: 'executing', execution_lock: 'lock-1' })]);

			const executor = vi.fn().mockResolvedValue({ id: 'new-item' });
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			await expect(service.review('approval-1', 'approve', { execute: executor })).rejects.toThrow();

			// The write ran exactly once and is never retried despite the persistence outage.
			expect(executor).toHaveBeenCalledTimes(1);
			// claim + failed completed persistence
			expect(tracker.history.update.filter((q) => q.sql.includes('directus_mcp_approvals'))).toHaveLength(2);
		});

		it('failed tool + failed failure persistence: never retried, error surfaces for TTL recovery', async () => {
			setupApproval(makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) }));
			tracker.on.select('directus_users').response([{ id: 'user-1', role: 'role-1', status: 'active' }]);
			tracker.on.select('directus_oauth_tokens').response([{ id: 'grant-1' }]);

			tracker.on.update('directus_mcp_approvals').response(1);
			tracker.on.update('directus_mcp_approvals').simulateErrorOnce(new Error('write unavailable'));

			const executor = vi.fn().mockRejectedValue(new Error('tool boom'));
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			// Fail closed: the failure record itself could not be persisted, so review rejects
			// (the row is left for TTL recovery) rather than reporting success.
			await expect(service.review('approval-1', 'approve', { execute: executor })).rejects.toThrow(
				/expected terminal state|Failed to persist terminal status/,
			);

			expect(executor).toHaveBeenCalledTimes(1);
			expect(tracker.history.update.filter((q) => q.sql.includes('directus_mcp_approvals'))).toHaveLength(2);
		});

		it('a row cancelled after claim (concurrent revocation) does not execute', async () => {
			// Row reads as pending; claim update applies to zero rows because a concurrent
			// revocation cancelled it first.
			setupApproval(makeApprovalRow({ input: JSON.stringify(writeArgs), input_preview: JSON.stringify(writeArgs) }));

			tracker.on.update('directus_mcp_approvals').response(0);

			const executor = vi.fn();
			const service = new McpApprovalsService({ knex: db, accountability: { ...reviewer, admin: true }, schema });

			const result = await service.review('approval-1', 'approve', { execute: executor });

			expect(executor).not.toHaveBeenCalled();
			expect(result.status).toBe('pending');
		});
	});

	describe('review output safety', () => {
		it('listForReview strips the canonical input even for admins', async () => {
			const secretArgs = { collection: 'users', action: 'create', data: { email: 'a@b.c', password: 'pw' } };

			// First approvals select: orphan-cancellation join finds no orphans.
			// Second: the actual list query.
			let approvalsReads = 0;

			tracker.on.select('directus_mcp_approvals').response(() => {
				approvalsReads += 1;
				return approvalsReads === 1
					? []
					: [
							makeApprovalRow({
								input: JSON.stringify(secretArgs),
								input_preview: JSON.stringify({ ...secretArgs, data: { email: 'a@b.c', password: '********' } }),
							}),
						];
			});

			const service = new McpApprovalsService({
				knex: db,
				accountability: { ...reviewer, admin: true },
				schema,
			});

			const rows = await service.listForReview();
			expect(rows[0]).not.toHaveProperty('input');
			expect(rows[0]!.input_preview).toMatchObject({ data: { password: '********' } });
		});
	});

	describe('revocation, expiry and recovery', () => {
		it('cancelForGrant only cancels pending rows of that grant', async () => {
			tracker.on.update('directus_mcp_approvals').response(2);

			const service = new McpApprovalsService({ knex: db, schema });
			const count = await service.cancelForGrant('client-a', 'user-1');

			expect(count).toBe(2);
			const sql = tracker.history.update[0]!.sql;
			expect(sql).toMatch(/status/);
			expect(String(tracker.history.update[0]!.bindings)).toContain('cancelled');
		});

		it('expireDue only touches due pending rows and is idempotent', async () => {
			tracker.on.update('directus_mcp_approvals').response(3);
			const service = new McpApprovalsService({ knex: db, schema });

			expect(await service.expireDue(new Date('2026-09-16T12:00:00Z'))).toBe(3);

			const query = tracker.history.update[0]!;
			// The CAS predicate lives in the bindings, not in the SQL text.
			expect(query.sql).toMatch(/expires_at/i);
			expect(query.bindings).toContain('pending');
			expect(query.bindings).toContain('expired');
		});

		it('recoverStaleClaims marks stuck executing rows failed and never retries', async () => {
			tracker.on.select('directus_mcp_approvals').response([{ id: 'stuck-1' }]);
			tracker.on.update('directus_mcp_approvals').response(1);

			const service = new McpApprovalsService({ knex: db, schema });
			const recovered = await service.recoverStaleClaims(new Date());

			expect(recovered).toBe(1);

			const select = tracker.history.select.find((q) => String(q.bindings).includes('executing'));
			expect(select).toBeTruthy();

			const update = tracker.history.update[0]!;
			expect(update.bindings).toContain('failed');
			expect(String(update.bindings)).toMatch(/not retried/);
			expect(String(update.bindings)).toContain('executing');
		});

		it('recoverStaleClaims returns zero when nothing is stuck', async () => {
			tracker.on.select('directus_mcp_approvals').response([]);
			const service = new McpApprovalsService({ knex: db, schema });
			expect(await service.recoverStaleClaims()).toBe(0);
		});

		it('cleanup expires, recovers and cancels orphaned grants in one pass', async () => {
			tracker.on.update('directus_mcp_approvals').response(1);
			tracker.on.select('directus_mcp_approvals').response([]);

			const service = new McpApprovalsService({ knex: db, schema });
			const result = await service.cleanup();

			expect(result).toEqual({ expired: 1, recovered: 0, orphaned: 0 });
		});

		it('cancelOrphanedGrants cancels pending approvals whose oauth grant is gone', async () => {
			// First select: stuck-claims lookup (nothing). Second: orphan join finds one id.
			tracker.on.select('directus_mcp_approvals').response([{ id: 'orphan-1' }]);
			tracker.on.update('directus_mcp_approvals').response(1);

			const service = new McpApprovalsService({ knex: db, schema });
			const count = await service.cancelOrphanedGrants();

			expect(count).toBe(1);
			expect(String(tracker.history.update[0]!.bindings)).toContain('cancelled');
		});

		it('agent polling a pending row with a revoked grant sees cancelled and cannot execute', async () => {
			tracker.on
				.select('directus_mcp_approvals')
				.response([makeApprovalRow({ status: 'pending', expires_at: new Date(Date.now() + 60_000).toISOString() })]);

			tracker.on.select('directus_oauth_tokens').response([]);
			tracker.on.update('directus_mcp_approvals').response(1);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const status = await service.getForAgent('approval-1', agent);

			expect(status.status).toBe('cancelled');
		});

		it('cancelForGrant directly cancels pending rows scoped to the revoked client+user', async () => {
			tracker.on.update('directus_mcp_approvals').response(3);

			const service = new McpApprovalsService({ knex: db, accountability: agent, schema });
			const count = await service.cancelForGrant('client-a', 'user-1');

			expect(count).toBe(3);

			const update = tracker.history.update.find((q) => q.sql.includes('directus_mcp_approvals'))!;
			expect(update.bindings).toContain('cancelled');
			expect(update.bindings).toContain('client-a');
			expect(update.bindings).toContain('user-1');
			expect(update.bindings).toContain('pending');
		});

		it('a row already cancelled by revocation returns without executing on review', async () => {
			// OAuth revocation flipped the row to cancelled before the reviewer clicked approve.
			tracker.on.select('directus_mcp_approvals').response([makeApprovalRow({ status: 'cancelled' })]);

			const executor = vi.fn();

			const service = new McpApprovalsService({
				knex: db,
				accountability: { ...reviewer, admin: true },
				schema,
			});

			const result = await service.review('approval-1', 'approve', { execute: executor });

			expect(executor).not.toHaveBeenCalled();
			expect(result.status).toBe('cancelled');
		});

		it('the review queue surfaces cancellations performed by the revocation path', async () => {
			// No orphan-cancellation join needed (revocation already cancelled directly);
			// the queue read returns the cancelled row.
			tracker.on
				.select('directus_mcp_approvals')
				.response([makeApprovalRow({ status: 'cancelled', error: 'OAuth grant revoked before approval' })]);

			tracker.on.select('directus_oauth_tokens').response([{ id: 'grant-1' }]);

			const service = new McpApprovalsService({
				knex: db,
				accountability: { ...reviewer, admin: true },
				schema,
			});

			const rows = await service.listForReview({ status: 'cancelled' });

			expect(rows).toHaveLength(1);
			expect(rows[0]!.status).toBe('cancelled');
		});
	});
});
