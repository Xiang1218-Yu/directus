import { ErrorCode, InvalidPayloadError, isDirectusError } from '@directus/errors';
import type { PrimaryKey } from '@directus/types';
import express from 'express';
import { UUID_REGEX } from '../constants.js';
import { getFlowManager } from '../flows.js';
import checkIsLocked from '../middleware/is-locked.js';
import { respond } from '../middleware/respond.js';
import useCollection from '../middleware/use-collection.js';
import { validateBatch } from '../middleware/validate-batch.js';
import { FlowSessionsService } from '../services/flow-sessions.js';
import { FlowsService } from '../services/flows.js';
import { MetaService } from '../services/meta.js';
import asyncHandler from '../utils/async-handler.js';
import { sanitizeQuery } from '../utils/sanitize-query.js';

const router = express.Router();

router.use(useCollection('directus_flows'));

const webhookFlowHandler = asyncHandler(async (req, res, next) => {
	const flowManager = getFlowManager();

	const { result, cacheEnabled } = await flowManager.runWebhookFlow(
		`${req.method}-${req.params['pk']}`,
		{
			path: req.path,
			query: req.query,
			body: req.body,
			method: req.method,
			headers: req.headers,
		},
		{
			accountability: req.accountability,
			schema: req.schema,
		},
	);

	if (!cacheEnabled) {
		res.locals['cache'] = false;
	}

	res.locals['payload'] = result;
	return next();
});

router.get(`/trigger/:pk(${UUID_REGEX})`, checkIsLocked('flows'), webhookFlowHandler, respond);
router.post(`/trigger/:pk(${UUID_REGEX})`, checkIsLocked('flows'), webhookFlowHandler, respond);

// ------------- Flow debug sessions ------------- //

router.post(
	`/:pk(${UUID_REGEX})/sessions`,
	checkIsLocked('flows'),
	asyncHandler(async (req, res, next) => {
		if (req.body === undefined || typeof req.body !== 'object' || Array.isArray(req.body)) {
			throw new InvalidPayloadError({ reason: '"input" is required' });
		}

		const service = new FlowSessionsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const key = await service.startSession(req.params['pk']!, req.body['input'] ?? null, req.body['name'] ?? undefined);

		const session = await service.readSession(String(key));

		res.locals['payload'] = { data: session };
		return next();
	}),
	respond,
);

router.get(
	`/:pk(${UUID_REGEX})/sessions`,
	asyncHandler(async (req, res, next) => {
		const service = new FlowSessionsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		res.locals['payload'] = { data: await service.readFlowSessions(req.params['pk']!) };
		return next();
	}),
	respond,
);

const sessionActionHandler = (action: 'rerun' | 'cancel') =>
	asyncHandler(async (req, res, next) => {
		const service = new FlowSessionsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		if (action === 'rerun') {
			const operation = req.body?.['operation'];

			await service.rerun(
				req.params['session']!,
				operation === undefined || operation === null ? null : String(operation),
				'input' in (req.body ?? {}) ? req.body['input'] : undefined,
			);
		} else {
			await service.cancel(req.params['session']!);
		}

		const session = await service.readSession(req.params['session']!);

		res.locals['payload'] = { data: session };
		return next();
	});

router.post(`/sessions/:session(${UUID_REGEX})/rerun`, checkIsLocked('flows'), sessionActionHandler('rerun'), respond);

router.post(`/sessions/:session(${UUID_REGEX})/cancel`, sessionActionHandler('cancel'), respond);

router.patch(
	`/sessions/:session(${UUID_REGEX})`,
	asyncHandler(async (req, res, next) => {
		const service = new FlowSessionsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		await service.markStatus(req.params['session']!, req.body['status']);

		res.locals['payload'] = { data: await service.readSession(req.params['session']!) };
		return next();
	}),
	respond,
);

router.delete(
	`/sessions/:session(${UUID_REGEX})`,
	asyncHandler(async (req, _res, next) => {
		const service = new FlowSessionsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		await service.deleteOne(req.params['session']!);
		return next();
	}),
	respond,
);

router.post(
	'/',
	asyncHandler(async (req, res, next) => {
		const service = new FlowsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const savedKeys: PrimaryKey[] = [];

		if (Array.isArray(req.body)) {
			const keys = await service.createMany(req.body);
			savedKeys.push(...keys);
		} else {
			const key = await service.createOne(req.body);
			savedKeys.push(key);
		}

		try {
			if (Array.isArray(req.body)) {
				const items = await service.readMany(savedKeys, req.sanitizedQuery);
				res.locals['payload'] = { data: items };
			} else {
				const item = await service.readOne(savedKeys[0]!, req.sanitizedQuery);
				res.locals['payload'] = { data: item };
			}
		} catch (error: any) {
			if (isDirectusError(error, ErrorCode.Forbidden)) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond,
);

const readHandler = asyncHandler(async (req, res, next) => {
	const service = new FlowsService({
		accountability: req.accountability,
		schema: req.schema,
	});

	const metaService = new MetaService({
		accountability: req.accountability,
		schema: req.schema,
	});

	const records = await service.readByQuery(req.sanitizedQuery);
	const meta = await metaService.getMetaForQuery(req.collection, req.sanitizedQuery);

	res.locals['payload'] = { data: records || null, meta };
	return next();
});

router.get('/', validateBatch('read'), readHandler, respond);
router.search('/', validateBatch('read'), readHandler, respond);

router.get(
	'/:pk',
	asyncHandler(async (req, res, next) => {
		const service = new FlowsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const record = await service.readOne(req.params['pk']!, req.sanitizedQuery);

		res.locals['payload'] = { data: record || null };
		return next();
	}),
	respond,
);

router.patch(
	'/',
	validateBatch('update'),
	asyncHandler(async (req, res, next) => {
		const service = new FlowsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		let keys: PrimaryKey[] = [];

		if (Array.isArray(req.body)) {
			keys = await service.updateBatch(req.body);
		} else if (req.body.keys) {
			keys = await service.updateMany(req.body.keys, req.body.data);
		} else {
			const sanitizedQuery = await sanitizeQuery(req.body.query, req.schema, req.accountability);
			keys = await service.updateByQuery(sanitizedQuery, req.body.data);
		}

		try {
			const result = await service.readMany(keys, req.sanitizedQuery);
			res.locals['payload'] = { data: result };
		} catch (error: any) {
			if (isDirectusError(error, ErrorCode.Forbidden)) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond,
);

router.patch(
	'/:pk',
	asyncHandler(async (req, res, next) => {
		const service = new FlowsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const primaryKey = await service.updateOne(req.params['pk']!, req.body);

		try {
			const item = await service.readOne(primaryKey, req.sanitizedQuery);
			res.locals['payload'] = { data: item || null };
		} catch (error: any) {
			if (isDirectusError(error, ErrorCode.Forbidden)) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond,
);

router.delete(
	'/',
	asyncHandler(async (req, _res, next) => {
		const service = new FlowsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		if (Array.isArray(req.body)) {
			await service.deleteMany(req.body);
		} else if (req.body.keys) {
			await service.deleteMany(req.body.keys);
		} else {
			const sanitizedQuery = await sanitizeQuery(req.body.query, req.schema, req.accountability);
			await service.deleteByQuery(sanitizedQuery);
		}

		return next();
	}),
	respond,
);

router.delete(
	'/:pk',
	asyncHandler(async (req, _res, next) => {
		const service = new FlowsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		await service.deleteOne(req.params['pk']!);

		return next();
	}),
	respond,
);

export default router;
