import { promises as fs } from 'fs';
import { parseJSON } from '@directus/utils';
import { load as fromYaml, dump as toYaml } from 'js-yaml';
import type { MigrationPackage } from './types.js';
import { validateMigrationPackage } from './validate-package.js';

/** Parses a migration package from JSON or YAML content based on the file extension. */
export function parseMigrationPackage(contents: string, filename?: string): MigrationPackage {
	let parsed: unknown;

	if (filename && /\.(yaml|yml)$/i.test(filename)) {
		parsed = fromYaml(contents);
	} else {
		parsed = parseJSON(contents);
	}

	validateMigrationPackage(parsed);

	return parsed;
}

/** Reads and validates a migration package file (`.json`, `.yaml` or `.yml`). */
export async function readMigrationPackage(filePath: string): Promise<MigrationPackage> {
	const contents = await fs.readFile(filePath, 'utf8');
	return parseMigrationPackage(contents, filePath);
}

/** Serializes a package to JSON or YAML based on the requested format. */
export function serializeMigrationPackage(pkg: MigrationPackage, format: 'json' | 'yaml'): string {
	if (format === 'yaml') return toYaml(pkg, { noRefs: true, lineWidth: -1 });
	return JSON.stringify(pkg, null, 2);
}
