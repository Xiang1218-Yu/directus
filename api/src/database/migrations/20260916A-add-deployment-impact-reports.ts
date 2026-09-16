import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable('directus_deployment_impact_reports', (table) => {
		table.uuid('id').primary().notNullable();
		table.uuid('deployment').nullable().references('id').inTable('directus_deployments').onDelete('CASCADE');
		table
			.uuid('deployment_run')
			.nullable()
			.references('id')
			.inTable('directus_deployment_runs')
			.onDelete('SET NULL');
		table
			.uuid('deployment_project')
			.nullable()
			.references('id')
			.inTable('directus_deployment_projects')
			.onDelete('SET NULL');
		table.string('status').notNullable().defaultTo('pending');
		table.integer('attempts').notNullable().defaultTo(0);
		table.json('requested_snapshot').nullable();
		table.json('requested_permissions').nullable();
		table.json('result').nullable();
		table.text('error').nullable();
		table.timestamp('expires_at').nullable();
		table.timestamp('started_at').nullable();
		table.timestamp('completed_at').nullable();
		table.timestamp('date_created').defaultTo(knex.fn.now());
		table.timestamp('date_updated').nullable();
		table.uuid('user_created').references('id').inTable('directus_users').onDelete('SET NULL');
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTable('directus_deployment_impact_reports');
}
