---
'@directus/api': minor
'@directus/types': minor
'@directus/system-data': minor
---

Added a flow run timeline: flow executions and every operation attempt (start/end, retries, allowlist-based redacted input/output summaries and sanitized errors) are now persisted in dedicated tables and are available through new read-only `GET /flow-runs` and `GET /flow-runs/:id` endpoints, filterable by flow, trigger time and status. Reads are scoped to the flows the user is allowed to read; operations gained configurable retry counts and unregistered operation types are recorded as failed nodes instead of failing silently. Timeline summaries only contain allowlisted generic fields with depth/length caps — raw operation payloads are never written to storage or general logs. Studio timeline polling stops automatically when runs finish, permission is denied or the page is unmounted.
