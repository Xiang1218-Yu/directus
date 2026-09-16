import { ErrorCode, isDirectusError } from '@directus/errors';
import type { PrimaryKey } from '@directus/types';
import express from 'express';
import { respond } from '../middleware/respond.js';
import useCollection from '../middleware/use-collection.js';
import { validateBatch } from '../middleware/validate-batch.js';
import { MetaService } from '../services/meta.js';
import { QualityRulesService } from '../services/quality-rules.js';
import { QualityRunsService } from '../services/quality-runs.js';
import asyncHandler from '../utils/async-handler.js';
import { sanitizeQuery } from '../utils/sanitize-query.js';

const router = express.Router();

router.use(useCollection('directus_quality_rules'));

router.post(
	'/',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRulesService({ accountability: req.accountability, schema: req.schema });
		const keys: PrimaryKey[] = [];

		if (Array.isArray(req.body)) {
			keys.push(...(await service.createMany(req.body)));
		} else {
			keys.push(await service.createOne(req.body));
		}

		try {
			res.locals['payload'] = {
				data: Array.isArray(req.body)
					? await service.readMany(keys, req.sanitizedQuery)
					: await service.readOne(keys[0]!, req.sanitizedQuery),
			};
		} catch (error) {
			if (isDirectusError(error, ErrorCode.Forbidden)) return next();
			throw error;
		}

		return next();
	}),
	respond,
);

const readHandler = asyncHandler(async (req, res, next) => {
	const service = new QualityRulesService({ accountability: req.accountability, schema: req.schema });
	const metaService = new MetaService({ accountability: req.accountability, schema: req.schema });
	const records = await service.readByQuery(req.sanitizedQuery);
	const meta = await metaService.getMetaForQuery(req.collection, req.sanitizedQuery);

	res.locals['payload'] = { data: records || null, meta };
	return next();
});

router.get('/', validateBatch('read'), readHandler, respond);
router.search('/', validateBatch('read'), readHandler, respond);

router.get(
	'/panel/rules',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRunsService({ accountability: req.accountability, schema: req.schema });
		res.locals['payload'] = { data: await service.listAccessibleRules() };
		return next();
	}),
	respond,
);

router.get(
	'/:pk',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRulesService({ accountability: req.accountability, schema: req.schema });
		res.locals['payload'] = { data: await service.readOne(req.params['pk']!, req.sanitizedQuery) };
		return next();
	}),
	respond,
);

router.get(
	'/:pk/runs',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRunsService({ accountability: req.accountability, schema: req.schema });

		const records = await service.readByQuery({
			...req.sanitizedQuery,
			filter: { ...(req.sanitizedQuery.filter ?? {}), rule: { _eq: req.params['pk']! } },
		});

		res.locals['payload'] = { data: records };
		return next();
	}),
	respond,
);

router.get(
	'/:pk/panel',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRunsService({ accountability: req.accountability, schema: req.schema });
		res.locals['payload'] = { data: await service.getPanelContext(req.params['pk']!) };
		return next();
	}),
	respond,
);

router.get(
	'/:pk/findings',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRunsService({ accountability: req.accountability, schema: req.schema });
		const { data, meta } = await service.listFindings(req.params['pk']!, req.sanitizedQuery);
		res.locals['payload'] = { data, meta: { total_count: meta } };
		return next();
	}),
	respond,
);

router.post(
	'/:pk/run',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRunsService({ accountability: req.accountability, schema: req.schema });
		const id = await service.start(req.params['pk']!);
		res.locals['payload'] = { data: { id } };
		return next();
	}),
	respond,
);

router.post(
	'/runs/:runId/cancel',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRunsService({ accountability: req.accountability, schema: req.schema });
		await service.cancel(req.params['runId']!);
		res.locals['payload'] = { data: { id: req.params['runId'], status: 'canceled' } };
		return next();
	}),
	respond,
);

router.patch(
	'/',
	validateBatch('update'),
	asyncHandler(async (req, res, next) => {
		const service = new QualityRulesService({ accountability: req.accountability, schema: req.schema });
		let keys: PrimaryKey[];

		if (Array.isArray(req.body)) {
			keys = await service.updateBatch(req.body);
		} else if (req.body.keys) {
			keys = await service.updateMany(req.body.keys, req.body.data);
		} else {
			keys = await service.updateByQuery(
				await sanitizeQuery(req.body.query, req.schema, req.accountability),
				req.body.data,
			);
		}

		try {
			res.locals['payload'] = { data: await service.readMany(keys, req.sanitizedQuery) };
		} catch (error) {
			if (isDirectusError(error, ErrorCode.Forbidden)) return next();
			throw error;
		}

		return next();
	}),
	respond,
);

router.patch(
	'/:pk',
	asyncHandler(async (req, res, next) => {
		const service = new QualityRulesService({ accountability: req.accountability, schema: req.schema });
		const key = await service.updateOne(req.params['pk']!, req.body);

		try {
			res.locals['payload'] = { data: await service.readOne(key, req.sanitizedQuery) };
		} catch (error) {
			if (isDirectusError(error, ErrorCode.Forbidden)) return next();
			throw error;
		}

		return next();
	}),
	respond,
);

router.delete(
	'/',
	asyncHandler(async (req, _res, next) => {
		const service = new QualityRulesService({ accountability: req.accountability, schema: req.schema });

		if (Array.isArray(req.body)) await service.deleteMany(req.body);
		else if (req.body.keys) await service.deleteMany(req.body.keys);
		else await service.deleteByQuery(await sanitizeQuery(req.body.query, req.schema, req.accountability));

		return next();
	}),
	respond,
);

router.delete(
	'/:pk',
	asyncHandler(async (req, _res, next) => {
		const service = new QualityRulesService({ accountability: req.accountability, schema: req.schema });
		await service.deleteOne(req.params['pk']!);
		return next();
	}),
	respond,
);

export default router;
