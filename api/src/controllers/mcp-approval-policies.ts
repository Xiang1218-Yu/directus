import { ForbiddenError } from '@directus/errors';
import type { PrimaryKey } from '@directus/types';
import { Router } from 'express';
import { respond } from '../middleware/respond.js';
import useCollection from '../middleware/use-collection.js';
import { validateBatch } from '../middleware/validate-batch.js';
import { ItemsService } from '../services/items.js';
import { MetaService } from '../services/meta.js';
import asyncHandler from '../utils/async-handler.js';
import { sanitizeQuery } from '../utils/sanitize-query.js';

const router = Router();

router.use(useCollection('directus_mcp_approval_policies'));

// Only admins configure approval policy; reviewers interact with /mcp-approvals instead.
router.use((req, _res, next) => {
	if (!req.accountability?.admin) {
		throw new ForbiddenError();
	}

	next();
});

const readHandler = asyncHandler(async (req, res, next) => {
	const service = new ItemsService('directus_mcp_approval_policies', {
		accountability: req.accountability,
		schema: req.schema,
	});

	const metaService = new MetaService({
		accountability: req.accountability,
		schema: req.schema,
	});

	const records = await service.readByQuery(req.sanitizedQuery);
	const meta = await metaService.getMetaForQuery('directus_mcp_approval_policies', req.sanitizedQuery);

	res.locals['payload'] = { data: records || null, meta };
	return next();
});

router.get('/', validateBatch('read'), readHandler, respond);
router.search('/', validateBatch('read'), readHandler, respond);

router.get(
	'/:id',
	asyncHandler(async (req, res, next) => {
		const service = new ItemsService('directus_mcp_approval_policies', {
			accountability: req.accountability,
			schema: req.schema,
		});

		const record = await service.readOne(req.params['id']!, req.sanitizedQuery);
		res.locals['payload'] = { data: record ?? null };
		return next();
	}),
	respond,
);

router.post(
	'/',
	asyncHandler(async (req, res, next) => {
		const service = new ItemsService('directus_mcp_approval_policies', {
			accountability: req.accountability,
			schema: req.schema,
		});

		const keys = await service.createMany(req.body['keys'] ?? [req.body]);

		try {
			const records = await service.readMany(keys, req.sanitizedQuery);
			res.locals['payload'] = { data: records || null };
		} catch {
			res.locals['payload'] = { data: keys };
		}

		return next();
	}),
	respond,
);

router.patch(
	'/',
	validateBatch('update'),
	asyncHandler(async (req, res, next) => {
		const service = new ItemsService('directus_mcp_approval_policies', {
			accountability: req.accountability,
			schema: req.schema,
		});

		let keys: PrimaryKey[];

		if (Array.isArray(req.body)) {
			keys = await service.updateBatch(req.body);
		} else if (req.body.keys) {
			keys = await service.updateMany(req.body.keys, req.body.data);
		} else {
			const sanitizedQuery = await sanitizeQuery(req.body.query, req.schema, req.accountability);
			keys = await service.updateByQuery(sanitizedQuery, req.body.data);
		}

		const records = await service.readMany(keys, req.sanitizedQuery);
		res.locals['payload'] = { data: records || null };
		return next();
	}),
	respond,
);

router.delete(
	'/',
	validateBatch('delete'),
	asyncHandler(async (req, _res, next) => {
		const service = new ItemsService('directus_mcp_approval_policies', {
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

router.patch(
	'/:id',
	asyncHandler(async (req, res, next) => {
		const service = new ItemsService('directus_mcp_approval_policies', {
			accountability: req.accountability,
			schema: req.schema,
		});

		await service.updateOne(req.params['id']!, req.body);
		const record = await service.readOne(req.params['id']!, req.sanitizedQuery);

		res.locals['payload'] = { data: record ?? null };
		return next();
	}),
	respond,
);

router.delete(
	'/:id',
	asyncHandler(async (req, _res, next) => {
		const service = new ItemsService('directus_mcp_approval_policies', {
			accountability: req.accountability,
			schema: req.schema,
		});

		await service.deleteOne(req.params['id']!);
		return next();
	}),
	respond,
);

export default router;
