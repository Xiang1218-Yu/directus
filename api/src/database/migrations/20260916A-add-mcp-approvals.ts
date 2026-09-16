import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable('directus_mcp_approval_policies', (table) => {
		table.uuid('id').primary().notNullable();
		table.string('name', 200).notNullable();
		table.boolean('enabled').notNullable().defaultTo(true);

		// All three scopes are optional: a null scope is a wildcard that matches every
		// value. All configured scopes must match (logical AND), e.g. a policy can
		// require approval for one specific tool coming from one specific client.
		table
			.string('oauth_client', 255)
			.nullable()
			.references('client_id')
			.inTable('directus_oauth_clients')
			.onDelete('CASCADE');

		table.uuid('role').nullable().references('id').inTable('directus_roles').onDelete('CASCADE');

		// Exact catalog tool name (e.g. "items", "files"), "write" (any non read-only
		// tool call), or "delete" (calls whose action is delete).
		table.string('tool', 100).nullable();

		table.integer('timeout_minutes').unsigned().notNullable().defaultTo(60);
		table.uuid('created_by').nullable().references('id').inTable('directus_users').onDelete('SET NULL');
		table.uuid('updated_by').nullable().references('id').inTable('directus_users').onDelete('SET NULL');
		table.timestamp('date_created').nullable();
		table.timestamp('date_updated').nullable();

		table.index(['enabled', 'oauth_client']);
	});

	await knex.schema.createTable('directus_mcp_approvals', (table) => {
		table.uuid('id').primary().notNullable();

		// pending -> approved -> executing -> completed | failed
		// pending -> rejected | expired | cancelled
		// executing -> failed (a stale claim is recovered; the request is never retried)
		table.string('status', 20).notNullable().defaultTo('pending').index();

		table
			.string('oauth_client', 255)
			.nullable()
			.references('client_id')
			.inTable('directus_oauth_clients')
			.onDelete('CASCADE');

		table.uuid('user').notNullable().references('id').inTable('directus_users').onDelete('CASCADE');
		table.uuid('role').nullable().references('id').inTable('directus_roles').onDelete('SET NULL');

		table.string('tool', 100).notNullable();
		// Action derived from the validated args ("create", "update", "delete", ...).
		table.string('action', 100).nullable();
		// Target collection when the tool operates against one -- drives the reviewer's
		// permission checks.
		table.string('collection', 64).nullable();

		// Canonical, validated tool input. Read back on approval so the agent can never
		// influence the executed call after the request was created.
		table.json('input').notNullable();
		// Keys/fields that look sensitive (passwords, tokens, secrets) are masked.
		table.json('input_preview').nullable();

		table.uuid('policy').nullable().references('id').inTable('directus_mcp_approval_policies').onDelete('SET NULL');

		table.timestamp('expires_at').notNullable().index();

		table.uuid('requested_by').notNullable().references('id').inTable('directus_users').onDelete('CASCADE');
		table.timestamp('requested_at').notNullable().defaultTo(knex.fn.now());

		table.uuid('reviewed_by').nullable().references('id').inTable('directus_users').onDelete('SET NULL');
		table.timestamp('reviewed_at').nullable();
		table.text('review_note').nullable();

		// Set while the approved call is being executed. Acts as the compare-and-swap
		// guard against concurrent replay: only one worker can move a row from
		// "approved" to "executing".
		table.string('execution_lock', 64).nullable();
		table.timestamp('execution_locked_at').nullable();
		table.integer('attempts').unsigned().notNullable().defaultTo(0);
		table.timestamp('completed_at').nullable();

		table.json('result').nullable();
		table.text('error').nullable();

		// Idempotency: identical requests already pending/completed are reused instead
		// of creating a second approval (and therefore a second execution).
		table.string('request_hash', 64).notNullable();

		table.index(['user', 'status']);
		table.index(['oauth_client', 'status']);

		// Idempotency: at most one live row per (requester, canonical request). Resetting
		// an expired/cancelled row reuses it instead of inserting a duplicate.
		table.unique(['request_hash', 'user']);
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTable('directus_mcp_approvals');
	await knex.schema.dropTable('directus_mcp_approval_policies');
}
