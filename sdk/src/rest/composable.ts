import type { StaticTokenClient } from '../auth/types.js';
import type { DirectusClient } from '../types/client.js';
import { executeRestRequest } from './utils/execute-rest-request.js';
import type { RestClient, RestCommand, RestConfig } from './types.js';

const defaultConfigValues: RestConfig = {};

/**
 * Creates a client to communicate with the Directus REST API.
 *
 * @returns A Directus REST client.
 */
export const rest = (config: Partial<RestConfig> = {}) => {
	return <Schema>(client: DirectusClient<Schema>): RestClient<Schema> => {
		const restConfig = { ...defaultConfigValues, ...config };
		return {
			async request<Output = any>(getOptions: RestCommand<Output, Schema>): Promise<Output> {
				const options = getOptions();

				return executeRestRequest<Output>(
					client,
					this as Partial<StaticTokenClient<Schema>>,
					options,
					restConfig,
					config,
				);
			},
		};
	};
};
