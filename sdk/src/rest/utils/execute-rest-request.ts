import type { DirectusClient } from '../../types/client.js';
import type { RequestOptions } from '../../types/request.js';
import type { StaticTokenClient } from '../../auth/types.js';
import { getRequestUrl } from '../../utils/get-request-url.js';
import { request } from '../../utils/request.js';
import type { RestConfig } from '../types.js';

/**
 * The extensions mixed into a client that can be involved while executing a REST request.
 * The REST composable attaches the bearer token when a `getToken` function is available.
 */
export type RestRequestContext = StaticTokenClient<any>;

/**
 * Executes a resolved REST command through the same pipeline the REST composable uses:
 * content type handling, authentication header, request/response hooks and the shared
 * request utility. The offline queue reuses this for replays, so queued requests keep
 * the exact same return values and error types as direct requests.
 *
 * @param client The directus client
 * @param bindings The mixed-in extensions of the client (e.g. authentication)
 * @param options The resolved command options
 * @param restConfig Merged REST configuration (credentials, hooks)
 * @param rawConfig Raw REST config as passed by the caller (kept for hook behavior parity)
 */
export const executeRestRequest = async <Output>(
	client: DirectusClient<any>,
	bindings: Partial<RestRequestContext>,
	options: RequestOptions,
	restConfig: RestConfig,
	rawConfig: Partial<RestConfig> = {},
): Promise<Output> => {
	// all api requests require this content type
	if (!options.headers) {
		options.headers = {};
	}

	if ('Content-Type' in options.headers === false) {
		options.headers['Content-Type'] = 'application/json';
	} else if (options.headers['Content-Type'] === 'multipart/form-data') {
		// let the fetch function deal with multipart boundaries
		delete options.headers['Content-Type'];
	}

	// we need to use the bindings here instead of client to access overridden functions
	if ('getToken' in bindings && 'Authorization' in options.headers === false) {
		const token = await bindings.getToken!();

		if (token) {
			options.headers['Authorization'] = `Bearer ${token}`;
		}
	}

	const requestUrl = getRequestUrl(client.url, options.path, options.params);

	let fetchOptions: RequestInit = {
		method: options.method ?? 'GET',
		headers: options.headers ?? {},
	};

	if (options.signal) {
		fetchOptions.signal = options.signal;
	}

	if ('credentials' in restConfig) {
		fetchOptions.credentials = restConfig.credentials;
	}

	if (options.body) {
		fetchOptions['body'] = options.body;
	}

	// apply onRequest hook from command
	if (options.onRequest) {
		fetchOptions = await options.onRequest(fetchOptions);
	}

	// apply global onRequest hook
	if (restConfig.onRequest) {
		fetchOptions = await restConfig.onRequest(fetchOptions);
	}

	let result = await request<Output>(requestUrl.toString(), fetchOptions, client.globals.fetch);

	// apply onResponse hook from command
	if ('onResponse' in options) {
		result = await options.onResponse!(result, fetchOptions);
	}

	// apply global onResponse hook
	if ('onResponse' in rawConfig) {
		result = await rawConfig.onResponse!(result, fetchOptions);
	}

	return result as Output;
};
