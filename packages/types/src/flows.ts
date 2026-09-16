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
	date_created: string;
	user_created: string;
}

export type FlowSessionStatus = 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';

export type FlowSessionStepStatus = 'resolve' | 'reject' | 'unknown';

export interface FlowSessionStep {
	operation: string;
	key: string;
	status: FlowSessionStepStatus;
	options: Record<string, any> | null;
	data: unknown;
}

export interface FlowSessionRaw {
	id: string;
	flow: string;
	name: string | null;
	status: FlowSessionStatus;
	input: unknown;
	steps: FlowSessionStep[];
	error: unknown;
	attempts: number;
	started_operation: string | null;
	started_at: string;
	heartbeat: string | null;
	completed_at: string | null;
	date_created: string;
	user_created: string | null;
}
