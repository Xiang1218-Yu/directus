import { ForbiddenError } from '@directus/errors';
import { Router } from 'express';
import { z } from 'zod';
import { ALL_TOOLS, ToolRegistry } from '../ai/tools/index.js';
import { respond } from '../middleware/respond.js';
import { type ApprovalExecutor, McpApprovalsService, type ReviewDecision } from '../services/mcp-approvals/index.js';
import { SettingsService } from '../services/settings.js';
import asyncHandler from '../utils/async-handler.js';

const router = Router();

const StatusQuerySchema = z.enum([
	'pending',
	'approved',
	'rejected',
	'expired',
	'cancelled',
	'executing',
	'completed',
	'failed',
]);

const ReviewBodySchema = z
	.object({
		decision: z.enum(['approve', 'reject']),
		note: z.string().max(2000).optional(),
	})
	.strict();

router.use((req, _res, next) => {
	// The approval center is a Studio surface; OAuth agent sessions are restricted to the
	// MCP endpoint by mcp-oauth-guard and can never reach these routes.
	if (!req.accountability?.user) {
		return next(new ForbiddenError({ reason: 'Authentication is required for the MCP approval center' }));
	}

	next();
});

// GET /mcp-approvals -- pending queue + audit log (filtered by reviewer permissions)
router.get(
	'/',
	asyncHandler(async (req, res, next) => {
		const statusRaw = typeof req.query?.['status'] === 'string' ? req.query['status'] : null;
		const status = statusRaw ? StatusQuerySchema.parse(statusRaw) : null;

		const service = new McpApprovalsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const data = await service.listForReview({ status });

		res.locals['payload'] = { data };
		return next();
	}),
	respond,
);

// GET /mcp-approvals/:id -- audit detail (canonical input is never serialized)
router.get(
	'/:id',
	asyncHandler(async (req, res, next) => {
		const service = new McpApprovalsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const data = await service.getForReview(req.params['id']!);

		res.locals['payload'] = { data };
		return next();
	}),
	respond,
);

// POST /mcp-approvals/:id/approve | /reject
const decisionHandler = (decision: ReviewDecision) =>
	asyncHandler(async (req, res, next) => {
		const parsed = ReviewBodySchema.parse({ ...req.body, decision });

		const service = new McpApprovalsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		// Lazily constructed so reject decisions pay no settings/tool-registry cost.
		let execute: ApprovalExecutor | undefined;

		if (decision === 'approve') {
			const toolCatalog = new ToolRegistry(ALL_TOOLS);

			// Honor the global delete kill-switch even for approved replays.
			const settings = new SettingsService({ schema: req.schema });
			const { mcp_allow_deletes } = await settings.readSingleton({ fields: ['mcp_allow_deletes'] });

			execute = async ({ name, args, accountability, schema }) => {
				const registry = toolCatalog.mount({
					accountability,
					schema,
					allowDeletes: mcp_allow_deletes ?? false,
				});

				const result = await registry.executeApproved(name, args);

				if (!result.ok) {
					throw new Error(result.error.message);
				}

				return result.result?.data ?? null;
			};
		}

		const row = await service.review(req.params['id']!, parsed.decision, {
			note: parsed.note ?? null,
			// Only invoked on approve: run the original tool exactly once with the rebuilt
			// requester accountability.
			execute: execute ?? (async () => null),
		});

		res.locals['payload'] = { data: row };
		return next();
	});

router.post('/:id/approve', decisionHandler('approve'), respond);
router.post('/:id/reject', decisionHandler('reject'), respond);

export default router;
