import { useEnv } from '@directus/env';
import { useLogger } from '../logger/index.js';
import { McpApprovalsService } from '../services/mcp-approvals/index.js';
import { getSchema } from '../utils/get-schema.js';
import { scheduleSynchronizedJob, validateCron } from '../utils/schedule.js';

export default async function scheduleMcpApprovalsCleanup(): Promise<boolean> {
	const env = useEnv();

	if (env['MCP_APPROVALS_ENABLED'] !== true) return false;

	const schedule = String(env['MCP_APPROVAL_CLEANUP_SCHEDULE']);

	if (!validateCron(schedule)) {
		useLogger().error(`Invalid MCP_APPROVAL_CLEANUP_SCHEDULE: "${schedule}". MCP approval cleanup disabled.`);
		return false;
	}

	scheduleSynchronizedJob('mcp-approvals-cleanup', schedule, async () => {
		try {
			const schema = await getSchema();
			const service = new McpApprovalsService({ schema });
			const { expired, recovered } = await service.cleanup();

			if (expired > 0 || recovered > 0) {
				useLogger().info({ expired, recovered }, 'MCP approval cleanup');
			}
		} catch (error) {
			useLogger().error(error, 'MCP approval cleanup failed');
		}
	});

	return true;
}
