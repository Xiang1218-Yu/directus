import type { SettingsModuleBarLink, SettingsModuleBarModule } from '@directus/types';
import type { Knex } from 'knex';

type ModuleBar = (SettingsModuleBarLink | SettingsModuleBarModule)[];

export async function up(knex: Knex): Promise<void> {
	await knex.schema.createTable('directus_quality_rules', (table) => {
		table.uuid('id').primary().notNullable();
		table.string('name').notNullable();
		table.string('description');
		table.string('collection').notNullable();
		table.json('fields').notNullable();
		table.string('type').notNullable();
		table.json('options');
		table.string('schedule');
		table.string('status').notNullable().defaultTo('inactive');
		table.integer('version').notNullable().defaultTo(1);
		table.timestamp('date_created').defaultTo(knex.fn.now());
		table.timestamp('date_updated').defaultTo(knex.fn.now());
		table.uuid('user_created').references('id').inTable('directus_users').onDelete('SET NULL');
		table.uuid('user_updated').references('id').inTable('directus_users').onDelete('SET NULL');
	});

	await knex.schema.createTable('directus_quality_runs', (table) => {
		table.uuid('id').primary().notNullable();
		table.uuid('rule').notNullable().references('id').inTable('directus_quality_rules').onDelete('CASCADE');
		table.integer('rule_version').notNullable();
		table.string('trigger').notNullable();
		table.string('status').notNullable();
		table.integer('batch_size').notNullable().defaultTo(500);
		table.integer('scanned_count').notNullable().defaultTo(0);
		table.integer('finding_count').notNullable().defaultTo(0);
		table.text('error');
		table.timestamp('date_started').notNullable().defaultTo(knex.fn.now());
		table.timestamp('date_finished');
		table.uuid('user_created').references('id').inTable('directus_users').onDelete('SET NULL');
		table.index(['rule', 'status']);
		table.index('date_started');
	});

	await knex.schema.createTable('directus_quality_findings', (table) => {
		table.uuid('id').primary().notNullable();
		table.uuid('run').notNullable().references('id').inTable('directus_quality_runs').onDelete('CASCADE');
		table.uuid('rule').notNullable().references('id').inTable('directus_quality_rules').onDelete('CASCADE');
		table.string('collection').notNullable();
		table.string('item').notNullable();
		table.json('fields').notNullable();
		table.string('message');
		table.timestamp('date_created').notNullable().defaultTo(knex.fn.now());
		table.unique(['run', 'collection', 'item', 'rule']);
		table.index(['rule']);
		table.index(['collection', 'item']);
	});

	await updateModuleBar(knex, (moduleBar) => {
		if (moduleBar.find(({ id }) => id === 'quality-rules')) return moduleBar;

		const insightsIndex = moduleBar.findIndex(({ id }) => id === 'insights');

		moduleBar.splice(insightsIndex === -1 ? moduleBar.length : insightsIndex + 1, 0, {
			type: 'module',
			id: 'quality-rules',
			enabled: true,
		});

		return moduleBar;
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.dropTable('directus_quality_findings');
	await knex.schema.dropTable('directus_quality_runs');
	await knex.schema.dropTable('directus_quality_rules');

	await updateModuleBar(knex, (moduleBar) => moduleBar.filter(({ id }) => id !== 'quality-rules'));
}

async function updateModuleBar(knex: Knex, modify: (moduleBar: ModuleBar) => ModuleBar | undefined) {
	const result = await knex('directus_settings').select('module_bar', 'id').first();

	if (!result?.module_bar) return;

	const moduleBar = typeof result.module_bar === 'string' ? JSON.parse(result.module_bar) : result.module_bar;
	const updatedModuleBar = modify(moduleBar);
	if (!updatedModuleBar) return;

	await knex('directus_settings')
		.update({ module_bar: JSON.stringify(updatedModuleBar) })
		.where('id', result.id);
}
