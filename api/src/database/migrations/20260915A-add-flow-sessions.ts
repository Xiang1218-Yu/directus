import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable('directus_flow_sessions', (table) => {
		table.uuid('id').primary().notNullable();
		table.uuid('flow').notNullable().references('id').inTable('directus_flows').onDelete('CASCADE');
		table.string('name');
		table.string('status').notNullable().defaultTo('running'); // running | cancelling | succeeded | failed | cancelled
		table.text('input'); // redacted test input (JSON)
		table.text('steps'); // redacted per-operation results (JSON)
		table.text('error'); // redacted terminal error (JSON)
		table.integer('attempts').notNullable().defaultTo(1);
		table.uuid('started_operation'); // operation the current/final attempt resumed from
		table.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
		table.timestamp('heartbeat'); // bumped after every step, used to detect orphaned runs
		table.timestamp('completed_at');
		table.timestamp('date_created').defaultTo(knex.fn.now());
		table.uuid('user_created').references('id').inTable('directus_users').onDelete('SET NULL');

		table.index(['flow', 'date_created']);
		table.index(['status', 'heartbeat']);
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTable('directus_flow_sessions');
}
