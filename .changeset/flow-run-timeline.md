---
'@directus/api': minor
'@directus/types': minor
'@directus/system-data': minor
---

Added a flow run timeline: flow executions and every operation attempt (start/end, retries, redacted input/output summaries and sanitized errors) are now persisted in dedicated tables and are available through new read-only `GET /flow-runs` and `GET /flow-runs/:id` endpoints, filterable by flow, trigger time and status. Reads are scoped to the flows the user is allowed to read; operations gained configurable retry counts. Raw operation payloads are never written to general logs.
