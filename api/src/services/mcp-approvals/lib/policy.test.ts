import { describe, expect, it } from 'vitest';
import {
	approvalRoles,
	deriveAction,
	deriveCollection,
	findMatchingPolicy,
	isTerminalStatus,
	maskSensitiveInput,
	policyMatches,
	TERMINAL_STATUSES,
} from './policy.js';

describe('MCP approvals / policy matching', () => {
	const baseCtx = {
		oauthClient: 'client-a',
		roles: ['role-a', 'role-b'],
		tool: 'items',
		isWrite: true,
		action: 'create',
	};

	it('matches a wildcard policy for every write', () => {
		expect(policyMatches({ enabled: true }, baseCtx)).toBe(true);
	});

	it('never matches disabled policies', () => {
		expect(policyMatches({ enabled: false }, baseCtx)).toBe(false);
	});

	it('matches by exact oauth client', () => {
		expect(policyMatches({ enabled: true, oauth_client: 'client-a' }, baseCtx)).toBe(true);
		expect(policyMatches({ enabled: true, oauth_client: 'client-other' }, baseCtx)).toBe(false);
	});

	it('matches when the user holds any of the roles', () => {
		expect(policyMatches({ enabled: true, role: 'role-b' }, baseCtx)).toBe(true);
		expect(policyMatches({ enabled: true, role: 'role-x' }, baseCtx)).toBe(false);
	});

	it('supports the "write" pseudo-tool only for mutating calls', () => {
		expect(policyMatches({ enabled: true, tool: 'write' }, baseCtx)).toBe(true);
		expect(policyMatches({ enabled: true, tool: 'write' }, { ...baseCtx, isWrite: false })).toBe(false);
	});

	it('supports the "delete" pseudo-tool', () => {
		expect(policyMatches({ enabled: true, tool: 'delete' }, { ...baseCtx, action: 'delete' })).toBe(true);
		expect(policyMatches({ enabled: true, tool: 'delete' }, baseCtx)).toBe(false);

		expect(
			policyMatches({ enabled: true, tool: 'delete' }, { ...baseCtx, isWrite: false, action: 'read' }),
		).toBe(false);
	});

	it('matches exact tool names', () => {
		expect(policyMatches({ enabled: true, tool: 'items' }, baseCtx)).toBe(true);
		expect(policyMatches({ enabled: true, tool: 'files' }, baseCtx)).toBe(false);
	});

	it('combines all scopes with logical AND', () => {
		const policy = { enabled: true, oauth_client: 'client-a', role: 'role-a', tool: 'items' };
		expect(policyMatches(policy, baseCtx)).toBe(true);
		expect(policyMatches({ ...policy, tool: 'files' }, baseCtx)).toBe(false);
	});

	it('findMatchingPolicy returns the first match or null', () => {
		const policies = [
			{ id: 'a', enabled: true, tool: 'files' },
			{ id: 'b', enabled: true },
		];

		expect(findMatchingPolicy(policies, baseCtx)?.id).toBe('b');
		expect(findMatchingPolicy([policies[0]!], baseCtx)).toBeNull();
	});

	it('classifies terminal statuses', () => {
		for (const status of TERMINAL_STATUSES) {
			expect(isTerminalStatus(status)).toBe(true);
		}

		expect(isTerminalStatus('pending')).toBe(false);
		expect(isTerminalStatus('approved')).toBe(false);
		expect(isTerminalStatus('executing')).toBe(false);
	});
});

describe('MCP approvals / sensitive parameter masking', () => {
	it('masks common sensitive keys at every depth', () => {
		const input = {
			collection: 'users',
			action: 'create',
			data: {
				email: 'a@example.com',
				password: 'hunter2',
				profile: { api_key: 'abc123', name: 'A' },
			},
			meta: { nested: [{ token: 'x' }, { keep: true }] },
		};

		const { preview, sensitivePaths } = maskSensitiveInput(input);

		expect(preview).toEqual({
			collection: 'users',
			action: 'create',
			data: {
				email: 'a@example.com',
				password: '********',
				profile: { api_key: '********', name: 'A' },
			},
			meta: { nested: [{ token: '********' }, { keep: true }] },
		});

		expect(sensitivePaths).toEqual(['data.password', 'data.profile.api_key', 'meta.nested.0.token']);
	});

	it('does not mutate the original input', () => {
		const input = { data: { password: 'secret' } };
		maskSensitiveInput(input);
		expect(input.data.password).toBe('secret');
	});

	it('matches substrings case-insensitively', () => {
		const { preview } = maskSensitiveInput({ APIToken: 'x', SecretValue: 'y', name: 'z' });
		expect(preview).toEqual({ APIToken: '********', SecretValue: '********', name: 'z' });
	});
});

describe('MCP approvals / arg derivation', () => {
	it('derives action and collection', () => {
		expect(deriveAction({ action: 'delete' })).toBe('delete');
		expect(deriveAction({})).toBeNull();
		expect(deriveCollection({ collection: 'articles' })).toBe('articles');
		expect(deriveCollection({ collection: '' })).toBeNull();
	});

	it('collects unique roles from accountability', () => {
		expect(
			approvalRoles({ role: 'a', roles: ['a', 'b'], user: 'u', admin: false, app: false, ip: null }),
		).toEqual(['a', 'b']);
	});
});
