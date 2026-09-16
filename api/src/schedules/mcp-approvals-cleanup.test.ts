import { useEnv } from '@directus/env';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getSchema } from '../utils/get-schema.js';
import * as schedule from '../utils/schedule.js';
import { default as mcpApprovalsCleanupSchedule } from './mcp-approvals-cleanup.js';

vi.mock('@directus/env', () => ({
	useEnv: vi.fn().mockReturnValue({}),
}));

vi.mock('../utils/get-schema.js', () => ({
	getSchema: vi.fn().mockResolvedValue({}),
}));

const mockCleanup = vi.fn().mockResolvedValue({ expired: 0, recovered: 0 });

vi.mock('../services/mcp-approvals/index.js', () => ({
	McpApprovalsService: vi.fn().mockImplementation(() => ({
		cleanup: mockCleanup,
	})),
}));

vi.mock('../logger/index.js', () => ({
	useLogger: vi.fn().mockReturnValue({
		info: vi.fn(),
		error: vi.fn(),
	}),
}));

vi.spyOn(schedule, 'scheduleSynchronizedJob');
vi.spyOn(schedule, 'validateCron');

beforeEach(() => {
	vi.mocked(useEnv).mockReturnValue({
		MCP_APPROVALS_ENABLED: true,
		MCP_APPROVAL_CLEANUP_SCHEDULE: '*/15 * * * *',
	});
});

afterEach(() => {
	vi.clearAllMocks();
	mockCleanup.mockResolvedValue({ expired: 0, recovered: 0 });
});

describe('mcp approvals cleanup schedule', () => {
	test('returns early when approvals are disabled', async () => {
		vi.mocked(useEnv).mockReturnValue({ MCP_APPROVALS_ENABLED: false });

		const res = await mcpApprovalsCleanupSchedule();

		expect(schedule.scheduleSynchronizedJob).not.toHaveBeenCalled();
		expect(res).toBe(false);
	});

	test('returns false for an invalid cron schedule', async () => {
		vi.mocked(useEnv).mockReturnValue({
			MCP_APPROVALS_ENABLED: true,
			MCP_APPROVAL_CLEANUP_SCHEDULE: '#',
		});

		const res = await mcpApprovalsCleanupSchedule();

		expect(schedule.validateCron).toHaveBeenCalledWith('#');
		expect(schedule.scheduleSynchronizedJob).not.toHaveBeenCalled();
		expect(res).toBe(false);
	});

	test('schedules cleanup with env cron', async () => {
		const res = await mcpApprovalsCleanupSchedule();

		expect(schedule.scheduleSynchronizedJob).toHaveBeenCalledWith(
			'mcp-approvals-cleanup',
			'*/15 * * * *',
			expect.any(Function),
		);

		expect(res).toBe(true);
	});

	test('scheduled callback gets schema and runs cleanup', async () => {
		await mcpApprovalsCleanupSchedule();

		const callback = vi.mocked(schedule.scheduleSynchronizedJob).mock.calls[0]![2]!;
		await callback(new Date());

		expect(getSchema).toHaveBeenCalled();
		expect(mockCleanup).toHaveBeenCalled();
	});
});
