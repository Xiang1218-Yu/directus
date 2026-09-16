import { InvalidPayloadError } from '@directus/errors';
import type { Permission, Snapshot } from '@directus/types';
import express from 'express';
import Joi from 'joi';
import { respond } from '../middleware/respond.js';
import useCollection from '../middleware/use-collection.js';
import { DeploymentImpactReportsService } from '../services/deployment-impact-reports.js';
import { MetaService } from '../services/meta.js';
import asyncHandler from '../utils/async-handler.js';

const router = express.Router();

router.use(useCollection('directus_deployment_impact_reports'));

const createReportSchema = Joi.object({
	snapshot: Joi.object().required(),
	permissions: Joi.array().items(Joi.object()),
	deployment_run: Joi.string(),
	deployment_project: Joi.string(),
	deployment: Joi.string(),
}).required();

router.post(
	'/',
	asyncHandler(async (req, res, next) => {
		const { error } = createReportSchema.validate(req.body);
		if (error) throw new InvalidPayloadError({ reason: error.message });

		const service = new DeploymentImpactReportsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const report = await service.createReport({
			snapshot: req.body.snapshot as Snapshot,
			...(req.body.permissions ? { permissions: req.body.permissions as Permission[] } : {}),
			...(req.body.deployment_run ? { deploymentRun: req.body.deployment_run } : {}),
			...(req.body.deployment_project ? { deploymentProject: req.body.deployment_project } : {}),
			...(req.body.deployment ? { deployment: req.body.deployment } : {}),
		});

		res.status(202);
		res.locals['payload'] = { data: report };
		return next();
	}),
	respond,
);

const readHandler = asyncHandler(async (req, res, next) => {
	const service = new DeploymentImpactReportsService({
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

router.get('/', readHandler, respond);
router.search('/', readHandler, respond);

router.get(
	'/:id',
	asyncHandler(async (req, res, next) => {
		const service = new DeploymentImpactReportsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const record = await service.readOne(req.params['id']!, req.sanitizedQuery);
		res.locals['payload'] = { data: record || null };
		return next();
	}),
	respond,
);

router.post(
	'/:id/retry',
	asyncHandler(async (req, res, next) => {
		const service = new DeploymentImpactReportsService({
			accountability: req.accountability,
			schema: req.schema,
		});

		const record = await service.retry(req.params['id']!);

		res.status(202);
		res.locals['payload'] = { data: record };
		return next();
	}),
	respond,
);

export default router;
