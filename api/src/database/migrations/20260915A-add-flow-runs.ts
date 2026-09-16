import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable('directus_flow_runs', (table) => {
		table.uuid('id').primary().notNullable();
		table.uuid('flow').notNullable().references('id').inTable('directus_flows').onDelete('CASCADE');
		table.string('trigger').notNullable();
		table.string('status').notNullable().defaultTo('running');
		table.timestamp('date_started').notNullable().defaultTo(knex.fn.now());
		table.timestamp('date_finished');
		table.uuid('user_created').references('id').inTable('directus_users').onDelete('SET NULL');
	});

	await knex.schema.createTable('directus_flow_run_nodes', (table) => {
		table.uuid('id').primary().notNullable();
		table.uuid('flow_run').notNullable().references('id').inTable('directus_flow_runs').onDelete('CASCADE');
		table.uuid('operation').references('id').inTable('directus_operations').onDelete('SET NULL');
		table.string('operation_key').notNullable();
		table.string('operation_type').notNullable();
		table.integer('attempt').notNullable().defaultTo(1);
		table.string('status').notNullable().defaultTo('running');
		table.timestamp('date_started').notNullable().defaultTo(knex.fn.now());
		table.timestamp('date_finished');
		table.text('input_summary');
		table.text('output_summary');
		table.text('error');
	});

	// The timeline is queried per flow ordered by trigger time, and filtered by status
	await knex.schema.alterTable('directus_flow_runs', (table) => {
		table.index(['flow', 'date_started'], 'directus_flow_runs_flow_date_started_index');
		table.index('status', 'directus_flow_runs_status_index');
	});

	await knex.schema.alterTable('directus_flow_run_nodes', (table) => {
		table.index(['flow_run', 'date_started'], 'directus_flow_run_nodes_run_date_started_index');
	});

	await knex.schema.alterTable('directus_operations', (table) => {
		table.integer('retries').notNullable().defaultTo(0);
		table.integer('retry_delay').notNullable().defaultTo(100);
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_operations', (table) => {
		table.dropColumn('retry_delay');
		table.dropColumn('retries');
	});

	await knex.schema.dropTable('directus_flow_run_nodes');
	await knex.schema.dropTable('directus_flow_runs');
}
