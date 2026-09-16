import { InvalidQueryError } from '@directus/errors';
import express from 'express';
import { UUID_REGEX } from '../constants.js';
import { respond } from '../middleware/respond.js';
import type { ReadFlowRunsQuery } from '../services/flow-runs.js';
import { FLOW_RUN_STATUSES, FlowRunsService } from '../services/flow-runs.js';
import asyncHandler from '../utils/async-handler.js';

const router = express.Router();

/**
 * GET /flow-runs?flow=&status=&triggered_after=&triggered_before=&page=&limit=
 */
router.get(
	'/',
	asyncHandler(async (req, res, next) => {
		const service = new FlowRunsService({
			schema: req.schema,
			accountability: req.accountability ?? null,
		});

		const query: ReadFlowRunsQuery = {};

		const flow = req.query['flow'];
		if (typeof flow === 'string') query['flow'] = flow;

		const triggeredAfter = req.query['triggered_after'];
		if (typeof triggeredAfter === 'string') query['triggeredAfter'] = triggeredAfter;

		const triggeredBefore = req.query['triggered_before'];
		if (typeof triggeredBefore === 'string') query['triggeredBefore'] = triggeredBefore;

		const status = parseStatus(req.query['status']);
		if (status) query['status'] = status;

		const page = parsePositiveInteger(req.query['page']);
		if (page) query['page'] = page;

		const limit = parsePositiveInteger(req.query['limit']);
		if (limit) query['limit'] = limit;

		const result = await service.readByQuery(query);

		res.locals['payload'] = result;
		return next();
	}),
	respond,
);

router.get(
	`/:id(${UUID_REGEX})`,
	asyncHandler(async (req, res, next) => {
		const service = new FlowRunsService({
			schema: req.schema,
			accountability: req.accountability ?? null,
		});

		const record = await service.readOne(req.params['id']!);

		res.locals['payload'] = { data: record };
		return next();
	}),
	respond,
);

function parseStatus(value: unknown): (typeof FLOW_RUN_STATUSES)[number] | undefined {
	if (typeof value !== 'string' || value.length === 0) return undefined;

	if (!FLOW_RUN_STATUSES.includes(value as (typeof FLOW_RUN_STATUSES)[number])) {
		throw new InvalidQueryError({
			reason: `Invalid status "${value}". Allowed values are: ${FLOW_RUN_STATUSES.join(', ')}`,
		});
	}

	return value as (typeof FLOW_RUN_STATUSES)[number];
}

function parsePositiveInteger(value: unknown): number | undefined {
	if (value === undefined) return undefined;

	const number = Number(value);

	if (!Number.isInteger(number) || number < 1) {
		throw new InvalidQueryError({ reason: `"${value}" is not a valid positive integer.` });
	}

	return number;
}

export default router;
