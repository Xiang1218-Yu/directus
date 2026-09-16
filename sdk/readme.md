# Directus JavaScript SDK

## Features

- **TypeScript first:** The SDK provides a robust and type-safe development experience.
- **Modular architecture:** The SDK is split into separate modules, giving you granular control over which features to
  include and which can be pruned at build-time.
- **Lightweight and dependency-free:** It does not require external libraries, ensuring a lighter bundle and streamlined
  experience.

## Composable Client

The client is split up in separate features you can mix and match to compose a client with only the features you need or
want.

```ts
const client = createDirectus<Schema>('https://directus.example.com');
```

This client is currently an empty wrapper without any functionality. Before you can do anything with it you'll need to
add some features. The following composables are available/in progress:

- `rest()` REST request functions
  - adds `.request(...)` on the client
- `graphql()` GraphQL request functions
  - adds `.query(...)` on the client
- `staticToken()` authentication functions
  - adds `.getToken()` and `.setToken()` on the client
- `authenticate()` authentication functions
  - adds `.login({ email, password })`, `.logout()`, `.refresh()` on the client
  - adds `.getToken()` and `.setToken()` on the client
- `realtime()` websocket connectivity
  - adds `.subscribe(...)`, `.sendMessage(...)`, `.onWebsocket('message', (message) => {})` on the client

For this example we'll build a client including `rest` and `graphql`:

```ts
const client = createDirectus<Schema>('https://directus.example.com').with(rest()).with(graphql());

// do a REST request
const restResult = await client.request(readItems('articles'));

// do a GraphQL request
const gqlResult = await client.query<OutputType>(`
    query {
        articles {
            id
            title
            author {
                first_name
            }
        }
    }
`);
```

## Authentication

```ts
const client = createDirectus<Schema>('https://directus.example.com').with(rest()).with(authentication('json'));

await client.login('admin@example.com', 'd1r3ctu5');

// do authenticated requests
```

```ts
const client = createDirectus<Schema>('https://directus.example.com')
	.with(rest())
	.with(staticToken('super-secure-token'));

// do authenticated requests
```

## Offline Queue

The optional `offline()` composable adds a durable request queue on top of `rest()` (and optionally
`authentication()`). Requests marked queueable are stored while the network is unavailable and
replayed once connectivity returns:

- **Dependency ordered replay** — declare `dependsOn` references so requests replay in the right order.
- **Idempotency keys** — queued requests send an `Idempotency-Key` header; duplicate submissions with
  the same key are collapsed into one request.
- **Bounded retries** — network errors and `5xx` responses retry with exponential backoff
  (`maxRetries`, default 3); `4xx` validation errors and authentication errors fail immediately.
- **Cancellation** — every queued request returns a promise with `.cancel()`, backed by an
  `AbortController` for in-flight replays.
- **Token refresh** — on `401/403` the queue single-flights `authentication()`'s refresh and replays
  once, without refreshing more than once per flush cycle.
- **Pluggable storage** — in-memory by default, or inject a persistence adapter (e.g.
  `webStorageQueueAdapter(localStorage)`) to survive page reloads. Bearer tokens are never persisted.

`FormData` uploads and `POST`/`PATCH` requests without an idempotency key are rejected at enqueue
time unless explicitly opted in (`allowFileUploads`, `allowNonIdempotent`).

```ts
import { createDirectus, rest, authentication, offline, webStorageQueueAdapter, updateItem } from '@directus/sdk';

const client = createDirectus<Schema>('https://directus.example.com')
	.with(authentication('json'))
	.with(rest())
	.with(offline({ storage: webStorageQueueAdapter(localStorage) }));

const queued = client.requestQueued(updateItem('articles', 1, { title: 'Saved later' }), {
	idempotencyKey: 'article-1-title',
});

// resolves after the replay with the normal SDK return type; rejects with the same SDK error types
await queued;

// control surface
queued.cancel();
await client.flush(); // manual replay (concurrent calls are single-flighted)
client.destroy(); // abort in-flight requests; queued entries stay persisted for reload recovery
```

## Real-Time

The `realtime()` extension allows you to work with a Directus REST WebSocket.

Subscribing to updates:

```ts
const client = createDirectus<Schema>('https://directus.example.com').with(
	realtime({
		authMode: 'public',
	}),
);

const { subscription, unsubscribe } = await client.subscribe('test', {
	query: { fields: ['*'] },
});

for await (const item of subscription) {
	console.log('subscription', { item });
}

// unsubscribe()
```

Receive/Send messages:

```ts
const client = createDirectus<Schema>('https://directus.example.com').with(
	realtime({
		authMode: 'public',
	}),
);

const stop = client.onWebSocket('message', (message) => {
	if ('type' in message && message['type'] === 'pong') {
		console.log('PONG received');
		stop();
	}
});

client.sendMessage({ type: 'ping' });
```

## Build Your Schema

```ts
// The main schema type containing all collections available
interface MySchema {
	collection_a: CollectionA[]; // regular collections are array types
	collection_b: CollectionB[];
	collection_c: CollectionC; // this is a singleton
	// junction collections are collections too
	collection_a_b_m2m: CollectionAB_Many[];
	collection_a_b_m2a: CollectionAB_Any[];
}

// collection A
interface CollectionA {
	id: number;
	status: string;
	// relations
	m2o: number | CollectionB;
	o2m: number[] | CollectionB[];
	m2m: number[] | CollectionAB_Many[];
	m2a: number[] | CollectionAB_Any[];
}

// Many-to-Many junction table
interface CollectionAB_Many {
	id: number;
	collection_a_id: CollectionA;
	collection_b_id: CollectionB;
}

// Many-to-Any junction table
interface CollectionAB_Any {
	id: number;
	collection_a_id: CollectionA;
	collection: 'collection_b' | 'collection_c';
	item: string | CollectionB | CollectionC;
}

// collection B
interface CollectionB {
	id: number;
	value: string;
}

// singleton collection
interface CollectionC {
	id: number;
	app_settings: string;
	something: string;
}
```
