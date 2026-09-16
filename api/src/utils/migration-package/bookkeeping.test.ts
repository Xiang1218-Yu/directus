import type { Knex } from 'knex';
import { describe, expect, test, vi } from 'vitest';
import { getPackageRecords } from './bookkeeping.js';
import { MIGRATION_PACKAGE_STEPS_TABLE } from './types.js';

describe('getPackageRecords', () => {
	test('ensures the table exists by default', async () => {
		const rows = [{ package: 'p', step: 's', status: 'completed', error: null, timestamp: new Date() }];

		const database = {
			schema: { hasTable: async () => true },
			select: () => database,
			from: () => database,
			where: () => database,
			orderBy: async () => rows,
		};

		const result = await getPackageRecords(database as unknown as Knex, 'p');

		expect(result).toEqual(rows);
	});

	test('does not create the table in read-only mode when it is missing', async () => {
		const createTable = vi.fn();
		const hasTable = vi.fn().mockResolvedValue(false);

		const database = {
			schema: {
				hasTable,
				createTable,
			},
		};

		const result = await getPackageRecords(database as unknown as Knex, 'p', { ensureTable: false });

		expect(result).toEqual([]);
		expect(createTable).not.toHaveBeenCalled();
		expect(database.schema.hasTable).toHaveBeenCalledWith(MIGRATION_PACKAGE_STEPS_TABLE);
	});
});
