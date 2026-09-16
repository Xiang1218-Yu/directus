---
'@directus/api': minor
'@directus/types': minor
'@directus/system-data': patch
'@directus/app': minor
'@directus/env': patch
---

Added shareable Flow debug sessions: start a session with test input, inspect every node's redacted output, rerun a failed branch from any node, cancel running sessions, and label the session as succeeded, failed, or cancelled. The flow executor always runs with the original test input and original upstream results, while the database, realtime events and REST responses only ever contain redacted copies. Sessions stream progress over the existing realtime subscription, ownership/flow permissions are enforced on every action, duplicate clicks converge to a single attempt via conditional state transitions, and crashed or abandoned runs are cancelled on restart and by a cluster-wide heartbeat sweep (`FLOWS_DEBUG_SESSION_TIMEOUT`, default 600 seconds).
