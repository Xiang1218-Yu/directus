import type { Accountability } from '@directus/types';
import { isObject } from '@directus/utils';

/**
 * Approval lifecycle:
 *
 * ```
 * pending ──approve──▶ approved ──claim──▶ executing ──▶ completed
 *    │                    │                   │
 *    │reject              │stale claim recover └─▶ failed
 *    ▼                    ▼
 * rejected            (claimed again by a later poller)
 *    │
 *    ├─expire──▶ expired
 *    └─cancel──▶ cancelled   (token revoked / client deleted)
 * ```
 *
 * Terminal states can never leave the row. In particular "completed", "rejected",
 * "expired", "cancelled" and "failed" rows are never executed, no matter how many
 * times an agent replays a request.
 */
export const APPROVAL_STATUSES = [
	'pending',
	'approved',
	'rejected',
	'expired',
	'cancelled',
	'executing',
	'completed',
	'failed',
] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const TERMINAL_STATUSES: ApprovalStatus[] = ['rejected', 'expired', 'cancelled', 'completed', 'failed'];

/** States from which a write must never be executed. */
export const NON_EXECUTABLE_STATUSES: ApprovalStatus[] = ['pending', 'rejected', 'expired', 'cancelled', 'failed'];

export function isTerminalStatus(status: string): status is ApprovalStatus {
	return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export type ApprovalPolicyScope = {
	enabled: boolean;
	oauth_client?: string | null;
	role?: string | null;
	tool?: string | null;
};

export type ApprovalMatchContext = {
	/** OAuth client_id of the MCP session; null for in-app (non-OAuth) sessions. */
	oauthClient: string | null;
	/** All roles of the requesting user (direct + inherited). */
	roles: string[];
	/** Catalog tool name, e.g. "items". */
	tool: string;
	/** Whether the concrete call mutates state. */
	isWrite: boolean;
	/** Normalized action when derivable ("delete", "create", ...). */
	action: string | null;
};

/**
 * Decide whether a policy requires approval for a concrete tool call.
 *
 * `tool` matching:
 * - `null` / wildcard: any tool
 * - `"write"`: any non read-only call
 * - `"delete"`: any call whose normalized action is `delete`
 * - anything else: exact tool-name match
 *
 * `oauth_client` and `role` are exact matches; null means "all".
 */
export function policyMatches(policy: ApprovalPolicyScope, ctx: ApprovalMatchContext): boolean {
	if (policy.enabled === false) return false;

	if (policy.oauth_client && policy.oauth_client !== ctx.oauthClient) return false;

	if (policy.role && !ctx.roles.includes(policy.role)) return false;

	if (policy.tool) {
		switch (policy.tool) {
			case 'write':
				if (!ctx.isWrite) return false;
				break;
			case 'delete':
				if (!ctx.isWrite || ctx.action !== 'delete') return false;
				break;
			default:
				if (policy.tool !== ctx.tool) return false;
		}
	}

	return true;
}

export function findMatchingPolicy<Policy extends ApprovalPolicyScope>(
	policies: readonly Policy[],
	ctx: ApprovalMatchContext,
): Policy | null {
	return policies.find((policy) => policyMatches(policy, ctx)) ?? null;
}

/** Keys whose values are always masked in the approval preview shown to reviewers. */
const SENSITIVE_KEY_PATTERN =
	/(password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization|cookie|session)/i;

const MASKED_VALUE = '********';

export type MaskResult = {
	preview: unknown;
	sensitivePaths: string[];
};

/**
 * Return a deep copy of `input` with sensitive leaf values masked, plus the list of
 * masked JSON paths. The stored canonical `input` (used for execution) is never
 * mutated; only the preview persisted next to it is masked.
 */
export function maskSensitiveInput(input: unknown): MaskResult {
	const sensitivePaths: string[] = [];

	const walk = (value: unknown, path: string[]): unknown => {
		if (Array.isArray(value)) {
			return value.map((item, index) => walk(item, [...path, String(index)]));
		}

		if (isObject(value)) {
			const out: Record<string, unknown> = {};

			for (const [key, child] of Object.entries(value)) {
				const childPath = [...path, key];

				if (SENSITIVE_KEY_PATTERN.test(key)) {
					out[key] = MASKED_VALUE;
					sensitivePaths.push(childPath.join('.'));
				} else {
					out[key] = walk(child, childPath);
				}
			}

			return out;
		}

		return value;
	};

	return { preview: walk(input, []), sensitivePaths };
}

/**
 * Derive the normalized write action from validated tool args ("create", "update",
 * "delete", "import", ...). Read calls return null.
 */
export function deriveAction(args: Record<string, unknown>): string | null {
	const action = args['action'];

	if (typeof action === 'string') return action;

	return null;
}

export function deriveCollection(args: Record<string, unknown>): string | null {
	const collection = args['collection'];

	return typeof collection === 'string' && collection.length > 0 ? collection : null;
}

export function approvalRoles(accountability: Accountability | undefined): string[] {
	if (!accountability) return [];

	return [...new Set([accountability.role, ...accountability.roles].filter((role): role is string => Boolean(role)))];
}
