import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_files', (table) => {
		table.string('checksum', 128).nullable();
		table.index(['storage', 'checksum'], 'directus_files_storage_checksum_index');
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_files', (table) => {
		table.dropIndex(['storage', 'checksum'], 'directus_files_storage_checksum_index');
		table.dropColumn('checksum');
	});
}
