import type { Query } from '../../../types/index.js';
import type { RestCommand } from '../../types.js';
import { throwIfEmpty } from '../../utils/index.js';

export type DeploymentImpactReportStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'expired';

export interface DeploymentImpactReportSummary {
	collections: number;
	fields: number;
	relations: number;
	permissions: number;
	pending_migrations: number;
	affected_records?: number;
	sensitive_fields?: number;
}

export interface DeploymentImpactReportCollectionStat {
	collection: string;
	action: 'create' | 'update' | 'delete';
	record_count?: number;
	accessible: boolean;
	sensitive_fields?: string[];
}

export interface DeploymentImpactReportFieldChange {
	collection: string;
	field: string;
	action: 'create' | 'update' | 'delete';
	sensitive?: boolean;
}

export interface DeploymentImpactPermissionChange {
	collection: string;
	action: string;
	change: 'added' | 'updated' | 'removed';
	fields?: string[];
}

export interface DeploymentImpactMigration {
	version: string;
	name: string;
}

export interface DeploymentImpactReportOutput {
	id: string;
	deployment: string | null;
	deployment_project: string | null;
	deployment_run: string | null;
	status: DeploymentImpactReportStatus;
	attempts: number;
	error: string | null;
	expires_at: string | null;
	started_at: string | null;
	completed_at: string | null;
	date_created: string;
	date_updated: string | null;
	result: {
		summary: DeploymentImpactReportSummary;
		collections: DeploymentImpactReportCollectionStat[];
		fields: DeploymentImpactReportFieldChange[];
		permissions: DeploymentImpactPermissionChange[];
		pending_migrations: DeploymentImpactMigration[];
		diff?: unknown;
	} | null;
}

export interface CreateDeploymentImpactReportOptions {
	snapshot: Record<string, any>;
	permissions?: Record<string, any>[];
	deployment_run?: string;
	deployment_project?: string;
	deployment?: string;
}

/**
 * List deployment impact reports.
 */
export const readDeploymentImpactReports =
	<Schema, TQuery extends Query<Schema, Record<string, any>>>(
		query?: TQuery,
	): RestCommand<DeploymentImpactReportOutput[], Schema> =>
	() => ({
		path: `/deployments/impact-reports`,
		params: query ?? {},
		method: 'GET',
	});

/**
 * Read a deployment impact report.
 */
export const readDeploymentImpactReport =
	<Schema>(
		id: string,
		query?: Omit<Query<Schema, Record<string, any>>, 'fields'> & { fields?: string[] },
	): RestCommand<DeploymentImpactReportOutput, Schema> =>
	() => {
		throwIfEmpty(id, 'Impact report ID cannot be empty');

		return {
			path: `/deployments/impact-reports/${id}`,
			params: query ?? {},
			method: 'GET',
		};
	};

/**
 * Create and asynchronously generate a deployment impact report.
 */
export const createDeploymentImpactReport =
	<Schema>(options: CreateDeploymentImpactReportOptions): RestCommand<DeploymentImpactReportOutput, Schema> =>
	() => ({
		path: `/deployments/impact-reports`,
		method: 'POST',
		body: JSON.stringify(options),
	});

/**
 * Retry a failed or expired deployment impact report.
 */
export const retryDeploymentImpactReport =
	<Schema>(id: string): RestCommand<DeploymentImpactReportOutput, Schema> =>
	() => {
		throwIfEmpty(id, 'Impact report ID cannot be empty');

		return {
			path: `/deployments/impact-reports/${id}/retry`,
			method: 'POST',
		};
	};
