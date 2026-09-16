export type QualityRuleType = 'empty' | 'broken_relation';

export type QualityRuleStatus = 'active' | 'inactive';
export type QualityRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export type QualityRunTrigger = 'manual' | 'schedule';

export interface QualityRule {
	id: string;
	name: string;
	description: string | null;
	collection: string;
	fields: string[];
	type: QualityRuleType;
	options: Record<string, unknown> | null;
	schedule: string | null;
	status: QualityRuleStatus;
	version: number;
}

export interface QualityRun {
	id: string;
	rule: string;
	rule_version: number;
	trigger: QualityRunTrigger;
	status: QualityRunStatus;
	batch_size: number;
	scanned_count: number;
	finding_count: number;
	error: string | null;
	date_started: string;
	date_finished: string | null;
}

export interface QualityFinding {
	id: string;
	run: string;
	rule: string;
	collection: string;
	item: string;
	fields: string[];
	message: string | null;
}
