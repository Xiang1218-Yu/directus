export type TriggerType = 'event' | 'schedule' | 'operation' | 'webhook' | 'manual';

type Status = 'active' | 'inactive';

export interface Flow {
	id: string;
	name: string | null;
	icon: string | null;
	description: string | null;
	status: Status;
	trigger: TriggerType | null;
	options: Record<string, any>;
	operation: Operation | null;
	accountability: 'all' | 'activity' | null;
}

export interface Operation {
	id: string;
	name: string | null;
	key: string;
	type: string;
	position_x: number;
	position_y: number;
	options: Record<string, any>;
	resolve: Operation | null;
	reject: Operation | null;
	retries: number;
	retry_delay: number;
}

export interface FlowRaw {
	id: string;
	name: string;
	icon: string | null;
	color: string | null;
	description: string | null;
	status: Status;
	trigger: TriggerType | null;
	options: Record<string, any> | null;
	operation: string | null;
	operations: OperationRaw[];
	date_created: string;
	user_created: string;
	accountability: 'all' | 'activity' | null;
}

export interface OperationRaw {
	id: string;
	name: string | null;
	key: string;
	type: string;
	position_x: number;
	position_y: number;
	options: Record<string, any>;
	resolve: string | null;
	reject: string | null;
	flow: string;
	retries: number;
	retry_delay: number;
	date_created: string;
	user_created: string;
}

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
