#!/usr/bin/env node
/* eslint-disable no-console -- CLI tool: printing to stdout/stderr is its purpose */
/**
 * Selects which CI checks to run based on the files changed in a pull request
 * (or any git range), so that a PR only pays for the tasks its changes can
 * actually affect.
 *
 * The workspace dependency graph is derived from `pnpm-workspace.yaml` and the
 * workspace manifests at runtime, so the selection stays correct as packages
 * are added, renamed or removed.
 *
 * Usage:
 *   pnpm ci:select                    # diff of HEAD against the merge-base with origin/main
 *   pnpm ci:select -- --base main     # diff against another ref
 *   pnpm ci:select -- --staged        # use staged changes instead of a branch diff
 *   pnpm ci:select -- file1 file2     # classify an explicit list of files (no git)
 *   pnpm ci:select -- --run           # execute the selected checks locally
 *   pnpm ci:select -- --json          # print the decisions as JSON
 *
 * In CI the exact same script writes step outputs to $GITHUB_OUTPUT (detected
 * automatically), which is how `.github/workflows/check.yml` and
 * `.github/workflows/e2e.yml` decide which jobs to run. Running it locally
 * therefore reproduces the selection CI would make for the same change.
 *
 * Selection rules:
 *   - Changing a workspace selects that workspace plus every workspace that
 *     (transitively) depends on it — cross-workspace effects are never missed.
 *   - Changing the lockfile, root configs or anything in `.github/` selects
 *     the full check suite, because those can affect every workspace at once.
 *   - The e2e matrix runs when a workspace changes that the API or the e2e
 *     suite depends on. The API's dependency on the app bundle is excluded on
 *     purpose: the e2e tests talk to the API and never load the app.
 *   - Renames count as a change to both the old and the new path. Deleted
 *     files still select their scope, but are not passed to lint/format.
 *   - When nothing relevant changed (e.g. a docs-only PR), the expensive jobs
 *     are skipped and only file-level checks (lint/format) still apply.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Root-level files whose modification can influence every workspace and every
 * check (dependency versions, lint/format/test configuration, build tooling).
 * A change to any of these selects the full check suite.
 */
const GLOBAL_ROOT_FILES = new Set([
	'package.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'eslint.config.js',
	'codecov.yaml',
	'docker-compose.yml',
	'docker-entrypoint.cjs',
	'ecosystem.config.cjs',
	'.npmrc',
	'.nvmrc',
	'.gitignore',
	'.prettierignore',
	'.stylelintignore',
]);

/** Additional root-level config files (only matched against paths without a directory). */
const GLOBAL_ROOT_PATTERNS = [
	/^Dockerfile(\..+)?$/,
	/^prettier\.config\.\w+$/,
	/^\.prettierrc(\..+)?$/,
	/^stylelint\.config\.\w+$/,
	/^\.stylelintrc(\..+)?$/,
	/^tsconfig(\..+)?\.json$/,
];

/** Directory prefixes that select the full check suite (CI configuration itself). */
const GLOBAL_PREFIXES = ['.github/'];

/** Extensions ESLint processes in this repository (see eslint.config.js). */
const LINT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue']);

/** Extensions stylelint processes (see the `lint:style` script). */
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.vue']);

/**
 * Workspaces whose changes can affect the end-to-end tests: the API and the
 * e2e suite themselves, plus everything they (transitively) depend on.
 */
const E2E_ROOTS = ['@directus/api', 'e2e'];

/**
 * Dependency edges ignored when computing e2e relevance. The API bundles the
 * built app, but the e2e tests only talk to the API and never load the app —
 * so app-only changes don't require the (expensive) multi-database matrix.
 */
const E2E_EXCLUDED_EDGES = [['@directus/api', '@directus/app']];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/ci-select-checks.mjs [options] [files...]

Options:
  --base <ref>   Git ref to diff against (default: origin/main, falling back to main)
  --head <ref>   Git ref to diff to (default: HEAD)
  --staged       Use staged changes instead of a branch diff
  --all          Select the full check suite unconditionally
  --run          Execute the selected checks locally (e2e is printed, not run)
  --json         Print the decisions as JSON
  --help         Show this help

Any positional arguments are treated as an explicit list of changed files.`;

function parseArgs(argv) {
	const options = { base: null, head: 'HEAD', staged: false, all: false, run: false, json: false, files: [] };

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		switch (arg) {
			case '--base':
				options.base = argv[++i];
				break;
			case '--head':
				options.head = argv[++i];
				break;
			case '--staged':
				options.staged = true;
				break;
			case '--all':
				options.all = true;
				break;
			case '--run':
				options.run = true;
				break;
			case '--json':
				options.json = true;
				break;
			case '--help':
			case '-h':
				console.log(USAGE);
				process.exit(0);
				break;
			default:
				if (arg.startsWith('--')) {
					console.error(`Unknown option: ${arg}\n\n${USAGE}`);
					process.exit(1);
				}

				options.files.push(arg);
		}
	}

	return options;
}

// ---------------------------------------------------------------------------
// Workspace graph
// ---------------------------------------------------------------------------

/** Reads the workspace globs from pnpm-workspace.yaml (the `packages:` list). */
function loadWorkspaceGlobs() {
	const yaml = readFileSync(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
	const globs = [];
	let inPackages = false;

	for (const line of yaml.split('\n')) {
		if (/^packages:/.test(line)) {
			inPackages = true;
			continue;
		}

		if (!inPackages) continue;
		if (/^\S/.test(line)) break; // reached the next top-level key

		const match = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);

		if (match) globs.push(match[1]);
	}

	return globs;
}

/** Expands the workspace globs and loads every workspace manifest. */
function loadWorkspaces() {
	const workspaces = [];

	for (const glob of loadWorkspaceGlobs()) {
		if (glob.startsWith('!')) continue;

		const dirs = glob.endsWith('/*')
			? readdirSync(path.join(ROOT, glob.slice(0, -2)), { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => `${glob.slice(0, -2)}/${entry.name}`)
			: [glob];

		for (const dir of dirs) {
			const manifestPath = path.join(ROOT, dir, 'package.json');
			if (!existsSync(manifestPath)) continue;

			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

			workspaces.push({
				name: manifest.name,
				dir,
				scripts: new Set(Object.keys(manifest.scripts ?? {})),
				manifest,
				workspaceDeps: [],
			});
		}
	}

	const names = new Set(workspaces.map((ws) => ws.name));

	for (const ws of workspaces) {
		const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
			.flatMap((field) => Object.keys(ws.manifest[field] ?? {}))
			.filter((dep) => names.has(dep));

		ws.workspaceDeps = [...new Set(deps)];
		delete ws.manifest;
	}

	return workspaces;
}

/** Returns the set of `starts` plus everything reachable via `next`. */
function closure(starts, next) {
	const seen = new Set(starts);
	const queue = [...starts];

	while (queue.length > 0) {
		const current = queue.pop();

		for (const value of next(current)) {
			if (!seen.has(value)) {
				seen.add(value);
				queue.push(value);
			}
		}
	}

	return seen;
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

function git(args) {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Parses `git diff --name-status -z` output into { status, path, oldPath? } entries. */
function parseNameStatus(output) {
	const tokens = output.split('\0').filter(Boolean);
	const files = [];

	for (let i = 0; i < tokens.length; i++) {
		const code = tokens[i][0];

		if (code === 'R' || code === 'C') {
			files.push({ status: code, oldPath: tokens[++i], path: tokens[++i] });
		} else {
			files.push({ status: code, path: tokens[++i] });
		}
	}

	return files;
}

/**
 * Returns the changed files for the requested range, or null when the range
 * can't be resolved (e.g. an unknown or all-zero base on a push event) — the
 * caller then falls back to selecting everything.
 */
function changedFilesFromGit({ base, head, staged }) {
	const range = [];

	if (staged) {
		range.push('--cached');
	} else {
		let mergeBase;

		try {
			mergeBase = git(['merge-base', base, head]).trim();
		} catch {
			return null;
		}

		if (!mergeBase) return null;
		range.push(mergeBase, head);
	}

	return parseNameStatus(git(['diff', '--name-status', '--find-renames', '-z', ...range]));
}

function defaultBase() {
	for (const candidate of ['origin/main', 'main']) {
		try {
			git(['rev-parse', '--verify', candidate]);
			return candidate;
		} catch {
			// try the next candidate
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Classification & selection
// ---------------------------------------------------------------------------

function classifyFile(file, workspacesByDir) {
	if (GLOBAL_PREFIXES.some((prefix) => file.startsWith(prefix))) return { scope: 'global' };

	if (!file.includes('/')) {
		const isGlobal = GLOBAL_ROOT_FILES.has(file) || GLOBAL_ROOT_PATTERNS.some((pattern) => pattern.test(file));
		return { scope: isGlobal ? 'global' : null };
	}

	for (const ws of workspacesByDir) {
		if (file === ws.dir || file.startsWith(`${ws.dir}/`)) return { scope: 'workspace', workspace: ws };
	}

	return { scope: null };
}

function selectChecks(files, { forceGlobal = false } = {}) {
	const workspaces = loadWorkspaces();
	const byName = new Map(workspaces.map((ws) => [ws.name, ws]));
	const byDir = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);

	// Reverse dependency graph: who depends on a given workspace?
	const dependents = new Map(workspaces.map((ws) => [ws.name, new Set()]));

	for (const ws of workspaces) {
		for (const dep of ws.workspaceDeps) dependents.get(dep).add(ws.name);
	}

	const changedPackages = new Set();
	const globalFiles = [];
	const existingFiles = []; // changed files that still exist on disk

	for (const file of files) {
		// A rename counts as a change to both the old and the new location, so
		// moving a file across scopes affects both.
		for (const p of file.oldPath ? [file.oldPath, file.path] : [file.path]) {
			const { scope, workspace } = classifyFile(p, byDir);

			if (scope === 'global') {
				globalFiles.push(p);
			} else if (scope === 'workspace') {
				changedPackages.add(workspace.name);
			}
		}

		if (file.status !== 'D') existingFiles.push(file.path);
	}

	const global = forceGlobal || globalFiles.length > 0;

	// A workspace is affected when it changed directly or when it (transitively)
	// depends on a changed workspace.
	const affected = closure([...changedPackages], (name) => dependents.get(name) ?? new Set());

	// Workspaces whose change can influence the e2e tests (see E2E_ROOTS).
	const e2eRelevant = closure(E2E_ROOTS, (name) =>
		(byName.get(name)?.workspaceDeps ?? []).filter(
			(dep) => !E2E_EXCLUDED_EDGES.some(([from, to]) => from === name && to === dep),
		),
	);

	const withScript = (script) => (name) => byName.get(name)?.scripts.has(script);
	const sorted = (names) => [...names].sort();

	// Mirror the CI jobs: unit tests run `test:coverage`, type checks run `typecheck`.
	const unitPackages = global
		? workspaces.filter((ws) => ws.scripts.has('test:coverage')).map((ws) => ws.name)
		: sorted([...affected].filter(withScript('test:coverage')));

	const typecheckPackages = global
		? workspaces.filter((ws) => ws.scripts.has('typecheck')).map((ws) => ws.name)
		: sorted([...affected].filter(withScript('typecheck')));

	const lintFiles = existingFiles.filter((file) => LINT_EXTENSIONS.has(path.extname(file)));
	const styleFiles = existingFiles.filter((file) => STYLE_EXTENSIONS.has(path.extname(file)));

	const e2ePackages = sorted([...changedPackages].filter((name) => e2eRelevant.has(name)));

	const filterArgs = (names) => names.map((name) => `--filter=${name}`).join(' ');
	const buildFilterArgs = (names) => names.map((name) => `--filter=${name}...`).join(' ');

	return {
		global,
		lint: global || lintFiles.length > 0,
		format: global || existingFiles.length > 0,
		stylelint: global || styleFiles.length > 0,
		unit: unitPackages.length > 0,
		typecheck: typecheckPackages.length > 0,
		e2e: global || e2ePackages.length > 0,
		lint_files: lintFiles.join(' '),
		format_files: existingFiles.join(' '),
		style_files: styleFiles.join(' '),
		unit_filters: global ? '' : filterArgs(unitPackages),
		typecheck_filters: global ? '' : filterArgs(typecheckPackages),
		// Build scope for the unit/typecheck jobs: the affected workspaces plus
		// their dependencies (`<name>...`). Empty means "build everything".
		build_filters: global ? '' : buildFilterArgs(sorted(affected)),
		// Additional context for the human-readable / JSON summary
		details: {
			changedFiles: files,
			changedPackages: sorted(changedPackages),
			affectedPackages: sorted(affected),
			unitPackages,
			typecheckPackages,
			e2ePackages,
			globalFiles: [...new Set(globalFiles)].sort(),
		},
	};
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const OUTPUT_KEYS = [
	'global',
	'lint',
	'format',
	'stylelint',
	'unit',
	'typecheck',
	'e2e',
	'lint_files',
	'format_files',
	'style_files',
	'unit_filters',
	'typecheck_filters',
	'build_filters',
];

function printSummary(selection, source) {
	const { details } = selection;
	const counts = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied' };
	const fileCount = (files) => files.split(' ').filter(Boolean).length;

	const row = (key, globalText, scopedText, noneText) => {
		const mark = selection[key] ? 'yes' : 'no';
		let note = noneText;

		if (selection[key]) {
			note = selection.global ? globalText : scopedText;
		}

		console.log(`  ${key.padEnd(10)} ${mark.padEnd(3)} ${note}`);
	};

	console.log(`Change source: ${source}`);
	console.log(`Changed files: ${details.changedFiles.length}`);

	for (const file of details.changedFiles) {
		const label = counts[file.status] ?? file.status;
		console.log(`  ${label.padEnd(9)} ${file.oldPath ? `${file.oldPath} -> ` : ''}${file.path}`);
	}

	if (selection.global) {
		const files = details.globalFiles.length > 0 ? details.globalFiles.join(', ') : '--all';
		console.log(`\nShared CI/root configuration changed (${files}) — selecting the full check suite.`);
	} else if (details.changedPackages.length > 0) {
		console.log(`\nChanged workspaces: ${details.changedPackages.join(', ')}`);
		console.log(`Affected workspaces (incl. dependents): ${details.affectedPackages.join(', ')}`);
	} else {
		console.log('\nNo workspace or shared configuration changed — expensive checks are skipped.');
	}

	console.log('\nSelected checks:');
	row('lint', '(full repo)', `(${fileCount(selection.lint_files)} files)`, '(no lintable files changed)');
	row('format', '(full repo)', `(${fileCount(selection.format_files)} files)`, '(no files to format)');
	row('stylelint', '(full repo)', `(${fileCount(selection.style_files)} files)`, '(no style files changed)');

	row(
		'typecheck',
		'(all workspaces)',
		`(${details.typecheckPackages.join(', ')})`,
		'(no affected workspace has a typecheck script)',
	);

	row('unit', '(all workspaces)', `(${details.unitPackages.join(', ')})`, '(no affected workspace has tests)');

	row(
		'e2e',
		'(shared config changed)',
		`(${details.e2ePackages.join(', ')} can affect the e2e tests)`,
		'(no e2e-relevant workspace changed)',
	);

	if (!selection.run) {
		console.log('\nRun the same selection locally: pnpm ci:select -- --run');
	}
}

function toCommands(selection) {
	const commands = [];
	const split = (value) => value.split(' ').filter(Boolean);

	if (selection.lint) {
		commands.push(
			selection.global
				? { label: 'lint (full repo)', args: ['pnpm', ['lint']] }
				: { label: 'lint (changed files)', args: ['pnpm', ['exec', 'eslint', ...split(selection.lint_files)]] },
		);
	}

	if (selection.format) {
		commands.push(
			selection.global
				? { label: 'format (full repo)', args: ['pnpm', ['format']] }
				: {
						label: 'format (changed files)',
						args: ['pnpm', ['exec', 'prettier', '--check', '--ignore-unknown', ...split(selection.format_files)]],
					},
		);
	}

	if (selection.stylelint) {
		commands.push(
			selection.global
				? { label: 'stylelint (full repo)', args: ['pnpm', ['lint:style']] }
				: {
						label: 'stylelint (changed files)',
						args: ['pnpm', ['exec', 'stylelint', ...split(selection.style_files), '--allow-empty-input']],
					},
		);
	}

	if (selection.unit || selection.typecheck) {
		commands.push(
			selection.global
				? { label: 'build (all workspaces)', args: ['pnpm', ['build']] }
				: {
						label: 'build (affected workspaces + dependencies)',
						args: ['pnpm', ['--recursive', ...split(selection.build_filters), 'run', 'build']],
					},
		);
	}

	if (selection.unit) {
		commands.push(
			selection.global
				? { label: 'unit tests (all workspaces)', args: ['pnpm', ['test:coverage', '--passWithNoTests']] }
				: {
						label: 'unit tests (affected workspaces)',
						args: ['pnpm', ['--recursive', ...split(selection.unit_filters), 'test:coverage', '--passWithNoTests']],
					},
		);
	}

	if (selection.typecheck) {
		commands.push(
			selection.global
				? { label: 'typecheck (all workspaces)', args: ['pnpm', ['--recursive', 'run', 'typecheck']] }
				: {
						label: 'typecheck (affected workspaces)',
						args: ['pnpm', ['--recursive', ...split(selection.typecheck_filters), 'run', 'typecheck']],
					},
		);
	}

	return commands;
}

function runCommands(selection) {
	for (const {
		label,
		args: [command, args],
	} of toCommands(selection)) {
		console.log(`\n$ ${command} ${args.join(' ')}   # ${label}`);
		const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });

		if (result.status !== 0) {
			console.error(`\n"${label}" failed with exit code ${result.status ?? 1}`);
			process.exit(result.status ?? 1);
		}
	}

	if (selection.e2e) {
		console.log('\ne2e tests are selected, but not run locally (they need a database per vendor).');

		console.log(
			'To run them: cd tests/e2e && pnpm vitest --project <sqlite|postgres|mysql|maria|mssql|oracle|cockroachdb>',
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	const options = parseArgs(process.argv.slice(2));

	let files;
	let source;

	if (options.all) {
		files = [];
		source = '--all (full check suite)';
	} else if (options.files.length > 0) {
		files = options.files.map((file) => ({ status: 'M', path: file }));
		source = 'explicit file list';
	} else {
		const base = options.base ?? defaultBase();

		if (!base && !options.staged) {
			console.error('Could not determine a base ref to diff against. Pass one explicitly with --base <ref>.');
			process.exit(1);
		}

		files = changedFilesFromGit({ base, head: options.head, staged: options.staged });

		if (files === null) {
			// Fail safe: when the diff can't be computed, select everything
			// rather than accidentally skipping required coverage.
			console.warn(`Warning: could not diff against "${base}" — selecting the full check suite.`);
			files = [];
			options.all = true;
		}

		source = options.staged ? 'staged changes' : `git diff ${base}...${options.head}`;
	}

	const selection = selectChecks(files, { forceGlobal: options.all });
	selection.run = options.run;

	if (process.env.GITHUB_OUTPUT) {
		const lines = OUTPUT_KEYS.map((key) => `${key}=${selection[key]}`);
		appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
	}

	if (options.json) {
		const { details, ...outputs } = selection;
		console.log(JSON.stringify({ ...outputs, details }, null, 2));
	} else {
		printSummary(selection, source);
	}

	if (options.run) runCommands(selection);
}

main();
