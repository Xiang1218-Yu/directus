import { Command, Option } from 'commander';
import { version } from 'directus/version';
import emitter from '../emitter.js';
import { startServer } from '../server.js';
import bootstrap from './commands/bootstrap/index.js';
import cacheClear from './commands/cache/clear.js';
import count from './commands/count/index.js';
import dbInstall from './commands/database/install.js';
import dbMigrate from './commands/database/migrate.js';
import init from './commands/init/index.js';
import rolesCreate from './commands/roles/create.js';
import { apply } from './commands/schema/apply.js';
import { packageApply } from './commands/schema/package-apply.js';
import { packageCheck } from './commands/schema/package-check.js';
import { packageCreate } from './commands/schema/package-create.js';
import { packageRollback } from './commands/schema/package-rollback.js';
import { snapshot } from './commands/schema/snapshot.js';
import keyGenerate from './commands/security/key.js';
import secretGenerate from './commands/security/secret.js';
import usersCreate from './commands/users/create.js';
import usersPasswd from './commands/users/passwd.js';
import { loadExtensions } from './load-extensions.js';

export async function createCli(): Promise<Command> {
	const program = new Command();
	program.allowExcessArguments();

	await loadExtensions();

	await emitter.emitInit('cli.before', { program });

	program.name('directus').usage('[command] [options]');
	program.version(version, '-v, --version');

	program.command('start').description('Start the Directus API').action(startServer);
	program.command('init').description('Create a new Directus Project').action(init);

	// Security
	const securityCommand = program.command('security');
	securityCommand.command('key:generate').description('Generate the app key').action(keyGenerate);
	securityCommand.command('secret:generate').description('Generate the app secret').action(secretGenerate);

	const dbCommand = program.command('database');
	dbCommand.command('install').description('Install the database').action(dbInstall);

	dbCommand
		.command('migrate:latest')
		.description('Upgrade the database')
		.action(() => dbMigrate('latest'));

	dbCommand
		.command('migrate:up')
		.description('Upgrade the database')
		.action(() => dbMigrate('up'));

	dbCommand
		.command('migrate:down')
		.description('Downgrade the database')
		.action(() => dbMigrate('down'));

	const usersCommand = program.command('users');

	usersCommand
		.command('create')
		.description('Create a new user')
		.option('--email <value>', `user's email`)
		.option('--password <value>', `user's password`)
		.option('--role <value>', `user's role`)
		.action(usersCreate);

	usersCommand
		.command('passwd')
		.description('Set user password')
		.option('--email <value>', `user's email`)
		.option('--password <value>', `user's new password`)
		.action(usersPasswd);

	const rolesCommand = program.command('roles');

	rolesCommand
		.command('create')
		.description('Create a new role')
		.option('--role <value>', `name for the role`)
		.option('--admin', `whether or not the role has admin access`)
		.option('--app', `whether or not the role has app access`)
		.action(rolesCreate);

	program
		.command('cache')
		.command('clear')
		.description('Clear the data and system caches')
		.option('--system', 'Clear the system cache only (schema, permissions)')
		.option('--data', 'Clear the data cache only')
		.action(cacheClear);

	program.command('count <collection>').description('Count the amount of items in a given collection').action(count);

	program
		.command('bootstrap')
		.description('Initialize or update the database')
		.option('--skipAdminInit', 'Skips the creation of the default Admin Role and User')
		.action(bootstrap);

	const schemaCommands = program.command('schema');

	schemaCommands
		.command('snapshot')
		.description('Create a new Schema Snapshot')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`, false)
		.addOption(new Option('--format <format>', 'JSON or YAML format').choices(['json', 'yaml']).default('yaml'))
		.argument('[path]', 'Path to snapshot file')
		.action(snapshot);

	schemaCommands
		.command('apply')
		.description('Apply a snapshot file to the current database')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`)
		.option('-d, --dry-run', 'Plan and log changes to be applied', false)
		.option(
			'--ignoreRules <value>',
			`Comma-separated list of collections and or fields to ignore. Format: "products.title,reviews" this will ignore applying changes to the title field in the products collection and the entire reviews collection`,
		)
		.argument('<path>', 'Path to snapshot file')
		.action(apply);

	const packageCommand = schemaCommands.command('package').description('Manage reviewable schema migration packages');

	packageCommand
		.command('create')
		.description('Create a migration package from a target snapshot (optionally diffed against a source snapshot)')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`)
		.addOption(new Option('--format <format>', 'JSON or YAML format').choices(['json', 'yaml']).default('yaml'))
		.option('--from <path>', 'Path to the source snapshot file (defaults to the current live schema)')
		.option('--id <value>', 'Explicit package id used for bookkeeping (defaults to a timestamped id)')
		.option('--author <value>', 'Author metadata written into the package')
		.option('--description <value>', 'Description metadata written into the package for reviewers')
		.option('--no-rollback', 'Omit the rollback steps that revert the package back to the source snapshot')
		.argument('<target>', 'Path to the target snapshot file')
		.argument('[output]', 'Path to write the package to (defaults to stdout)')
		.action((target: string, output: string | undefined, options: Parameters<typeof packageCreate>[1]) =>
			packageCreate(target, options, output),
		);

	packageCommand
		.command('check')
		.description('Run the read-only compatibility check of a migration package against the current database')
		.option('--allow-hash-mismatch', 'Skip the source/target hash mismatch warning', false)
		.option('--rollback', 'Check the rollback plan instead of the forward plan', false)
		.argument('<path>', 'Path to migration package file (JSON or YAML)')
		.action(packageCheck);

	packageCommand
		.command('apply')
		.description('Apply a migration package to the current database, resuming from the last completed step')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`)
		.option('-d, --dry-run', 'Run the compatibility check and print the plan without writing anything', false)
		.option('--allow-hash-mismatch', 'Skip the source/target hash mismatch warning', false)
		.argument('<path>', 'Path to migration package file (JSON or YAML)')
		.action(packageApply);

	packageCommand
		.command('rollback')
		.description('Roll back an applied migration package to its source snapshot, resuming from the last rollback step')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`)
		.option('-d, --dry-run', 'Run the compatibility check and print the rollback plan without writing anything', false)
		.option('--allow-hash-mismatch', 'Skip the target hash mismatch warning', false)
		.argument('<path>', 'Path to migration package file (JSON or YAML)')
		.action(packageRollback);

	await emitter.emitInit('cli.after', { program });

	return program;
}
