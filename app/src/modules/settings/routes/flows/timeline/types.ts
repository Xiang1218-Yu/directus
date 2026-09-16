export type FlowRunStatus = 'running' | 'success' | 'failed';

export type FlowRunNodeStatus = 'running' | 'success' | 'failed';

export interface FlowRun {
	id: string;
	flow: string;
	trigger: string;
	status: FlowRunStatus;
	date_started: string;
	date_finished: string | null;
	user_created: string | null;
}

export interface FlowRunNode {
	id: string;
	flow_run: string;
	operation: string | null;
	operation_key: string;
	operation_type: string;
	attempt: number;
	status: FlowRunNodeStatus;
	date_started: string;
	date_finished: string | null;
	input_summary: string | null;
	output_summary: string | null;
	error: string | null;
}

export interface FlowRunDetail extends FlowRun {
	nodes: FlowRunNode[];
}

export interface FlowRunsMeta {
	total: number;
	limit: number;
	page: number;
	total_pages: number;
}
