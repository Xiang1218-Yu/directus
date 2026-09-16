import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { respond } from '../middleware/respond.js';
import router from './deployment-impact-reports.js';

const mockCreateReport = vi.hoisted(() => vi.fn());
const mockReadByQuery = vi.hoisted(() => vi.fn());
const mockReadOne = vi.hoisted(() => vi.fn());
const mockRetry = vi.hoisted(() => vi.fn());
const mockRespond = vi.hoisted(() => vi.fn((_req, _res, next) => next()));

vi.mock('../middleware/respond.js', () => ({
	respond: mockRespond,
}));

vi.mock('../services/deployment-impact-reports.js', () => ({
	DeploymentImpactReportsService: vi.fn(() => ({
		createReport: mockCreateReport,
		readByQuery: mockReadByQuery,
		readOne: mockReadOne,
		retry: mockRetry,
	})),
}));

function getHandler(path: string, method: string) {
	const layer = (router as any).stack.find((item: any) => item.route?.path === path && item.route.methods[method]);

	const handlers = layer.route.stack
		.filter((entry: any) => entry.name !== 'useCollection' && entry.handle !== respond)
		.map((entry: any) => entry.handle);

	return handlers[handlers.length - 1] as (req: Request, res: Response, next: any) => Promise<void>;
}

function createRequest(body = {}, params = {}) {
	return {
		body,
		params,
		query: {},
		accountability: { admin: true },
		schema: { collections: {} },
		sanitizedQuery: {},
	} as unknown as Request;
}

function createResponse() {
	return {
		status: vi.fn(),
		locals: {},
	} as unknown as Response;
}

describe('deployment impact reports controller', () => {
	beforeEach(() => vi.clearAllMocks());

	it('creates a report and returns HTTP 202', async () => {
		const report = { id: 'report-1', status: 'pending' };
		mockCreateReport.mockResolvedValue(report);
		const req = createRequest({ snapshot: { collections: [] } });
		const res = createResponse();

		await getHandler('/', 'post')(req, res, vi.fn());

		expect(mockCreateReport).toHaveBeenCalledWith({
			snapshot: { collections: [] },
		});

		expect(res.status).toHaveBeenCalledWith(202);
		expect((res.locals as any).payload).toEqual({ data: report });
	});

	it('rejects report creation without a snapshot', async () => {
		const next = vi.fn();
		await getHandler('/', 'post')(createRequest({ snapshot: 'invalid' }), createResponse(), next);

		expect(next).toHaveBeenCalledWith(expect.any(Error));
		expect(mockCreateReport).not.toHaveBeenCalled();
	});

	it('reads a single report', async () => {
		const report = { id: 'report-1', status: 'completed' };
		mockReadOne.mockResolvedValue(report);
		const res = createResponse();

		await getHandler('/:id', 'get')(createRequest({}, { id: 'report-1' }), res, vi.fn());

		expect(mockReadOne).toHaveBeenCalledWith('report-1', {});
		expect((res.locals as any).payload).toEqual({ data: report });
	});

	it('retries a failed report and returns HTTP 202', async () => {
		const report = { id: 'report-1', status: 'pending' };
		mockRetry.mockResolvedValue(report);
		const res = createResponse();

		await getHandler('/:id/retry', 'post')(createRequest({}, { id: 'report-1' }), res, vi.fn());

		expect(mockRetry).toHaveBeenCalledWith('report-1');
		expect(res.status).toHaveBeenCalledWith(202);
		expect((res.locals as any).payload).toEqual({ data: report });
	});
});
