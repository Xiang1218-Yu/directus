import type { Permission } from './permissions.js';
import type { Snapshot } from './snapshot.js';

/**
 * Supported deployment provider types
 */
export const DEPLOYMENT_PROVIDER_TYPES = ['vercel', 'netlify'] as const;
export type ProviderType = (typeof DEPLOYMENT_PROVIDER_TYPES)[number];

/**
 * Credentials structure varies per provider
 * Stored encrypted in database as JSON string
 */
export type Credentials = Record<string, any>;

/**
 * Provider-specific options
 */
export type Options = Record<string, any>;

export type Status = 'building' | 'ready' | 'error' | 'canceled';

/**
 * Latest deployment summary for project overview
 */
export interface LatestDeployment {
	status: Status;
	created_at: Date;
	finished_at?: Date;
}

/**
 * Project from deployment provider (e.g. Vercel project)
 */
export interface Project {
	id: string;
	name: string;
	url?: string;
	framework?: string;
	/** Whether the project has a Git source and can trigger deployments */
	deployable: boolean;
	created_at?: Date;
	updated_at?: Date;
	/** Latest deployment info (only from getProject) */
	latest_deployment?: LatestDeployment;
}

/**
 * Deployment run
 */
export interface Deployment {
	id: string;
	project_id: string;
	status: Status;
	url?: string;
	created_at: Date;
	finished_at?: Date;
	error_message?: string;
	meta?: Record<string, any>;
}

/**
 * Deployment log entry
 */
export interface Log {
	timestamp: Date;
	type: 'stdout' | 'stderr' | 'info';
	message: string;
}

/**
 * Deployment details with logs
 */
export interface Details extends Deployment {
	logs?: Log[];
}

/**
 * Result of triggering a deployment
 */
export interface TriggerResult {
	deployment_id: string;
	status: Status;
	url?: string;
	created_at: Date;
}

/**
 * Deployment configuration
 */
export interface DeploymentConfig {
	id: string;
	provider: ProviderType;
	credentials: Credentials;
	options: Options | null;
	webhook_ids: string[] | null;
	webhook_secret: string | null;
	last_synced_at: string | null;
	date_created: string;
	projects?: StoredProject[];
}

/**
 * Webhook event types supported by providers
 */
export type DeploymentWebhookEventType =
	| 'deployment.created'
	| 'deployment.succeeded'
	| 'deployment.error'
	| 'deployment.canceled';

/**
 * Parsed webhook event from a provider
 */
export interface DeploymentWebhookEvent {
	type: DeploymentWebhookEventType;
	provider: ProviderType;
	project_external_id: string;
	deployment_external_id: string;
	status: Status;
	url?: string;
	target?: string;
	timestamp: Date;
	raw?: Record<string, any>;
}

/**
 * Result of registering a webhook with a provider
 */
export interface WebhookRegistrationResult {
	webhook_ids: string[];
	webhook_secret: string;
}

/**
 * Stored project
 */
export interface StoredProject {
	id: string;
	deployment: string;
	external_id: string;
	name: string;
	url: string | null;
	framework: string | null;
	deployable: boolean;
	date_created: string;
	user_created: string | null;
}

/**
 * Stored run
 */
export interface StoredRun {
	id: string;
	project: string;
	external_id: string;
	status: Status | null;
	target: string;
	date_created: string;
	user_created: string | null;
	url: string | null;
	started_at: string | null;
	completed_at: string | null;
}

export type DeploymentImpactReportStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'expired';

export interface DeploymentImpactCollectionStats {
	collection: string;
	action: 'create' | 'update' | 'delete';
	record_count?: number;
	accessible: boolean;
	sensitive_fields?: string[];
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

export interface DeploymentImpactReportResult {
	has_changes?: boolean;
	summary: {
		collections: number;
		fields: number;
		relations: number;
		permissions: number;
		pending_migrations: number;
		affected_records?: number;
		sensitive_fields?: number;
	};
	collections: DeploymentImpactCollectionStats[];
	fields: Array<{ collection: string; field: string; action: 'create' | 'update' | 'delete'; sensitive?: boolean }>;
	permissions: DeploymentImpactPermissionChange[];
	pending_migrations: DeploymentImpactMigration[];
	diff?: unknown;
}

export interface DeploymentImpactReport {
	id: string;
	deployment: string | null;
	deployment_project: string | null;
	deployment_run: string | null;
	status: DeploymentImpactReportStatus;
	attempts: number;
	requested_snapshot: Snapshot | null;
	requested_permissions: Permission[] | null;
	result: DeploymentImpactReportResult | null;
	error: string | null;
	expires_at: string | null;
	started_at: string | null;
	completed_at: string | null;
	date_created: string;
	date_updated: string | null;
	user_created: string | null;
}
