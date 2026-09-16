import { z } from 'zod';
import { defineTool } from '../define-tool.js';

export const ApprovalStatusInputSchema = z.object({
	approval: z.string().uuid().describe('The approval id returned with the APPROVAL_REQUIRED error'),
});

/**
 * Read-only tool agents use to poll an approval created by a gated write call.
 *
 * Visible in both the legacy flat tool list and the registry (where it is an inner tool
 * referenced by the `next` hint of an APPROVAL_REQUIRED error).
 */
export const approvalStatus = defineTool<z.infer<typeof ApprovalStatusInputSchema>>({
	name: 'approval-status',
	description:
		'Check the status of a write tool call that returned APPROVAL_REQUIRED. Poll with the approval id. When status is "completed", the original write ran exactly once and its result is included. "rejected", "expired" and "cancelled" are final -- never replay the original write.',
	keywords: ['approval', 'permission', 'pending', 'human', 'review'],
	inputSchema: ApprovalStatusInputSchema,
	validateSchema: ApprovalStatusInputSchema,
	readOnly: true,
	annotations: {
		readOnlyHint: true,
		title: 'Directus - Approval Status',
	},
	async handler({ args, schema, accountability }) {
		if (!accountability) {
			throw new Error('Authentication is required to check approval status');
		}

		// Lazily import to keep the approval service graph (database, permissions) out of
		// module load time for the regular MCP/AI tool registry.
		const { McpApprovalsService } = await import('../../../services/mcp-approvals/index.js');

		const service = new McpApprovalsService({ schema, accountability });
		const status = await service.getForAgent(args.approval, accountability);

		return {
			type: 'text',
			data: status,
		};
	},
});
