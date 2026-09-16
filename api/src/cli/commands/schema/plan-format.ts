import chalk from 'chalk';
import type { CompatibilityResult, MigrationPackageStep } from '../../../utils/migration-package/types.js';

/** Renders the ordered execution plan, marking completed/pending steps. */
export function formatPlan(
	steps: Pick<MigrationPackageStep, 'id' | 'name' | 'kind'>[],
	compatibility: Pick<CompatibilityResult, 'completed' | 'issues'>,
): string {
	const completed = new Set(compatibility.completed);
	const lines: string[] = [chalk.underline.bold(`Migration plan (${steps.length} steps):`)];

	for (const [index, step] of steps.entries()) {
		const status = completed.has(step.id) ? chalk.gray('[skip] already completed') : chalk.cyan('[pending]');
		lines.push(`  ${String(index + 1).padStart(3)}. ${step.id}  ${step.name}  ${status}`);
	}

	const warnings = compatibility.issues.filter((issue) => issue.level === 'warning');

	if (warnings.length > 0) {
		lines.push('');
		lines.push(chalk.yellow.underline('Warnings:'));
		for (const warning of warnings) lines.push(chalk.yellow(`  - ${warning.message}`));
	}

	return lines.join('\n');
}
