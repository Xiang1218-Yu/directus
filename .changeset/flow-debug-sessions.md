---
'@directus/api': minor
'@directus/types': minor
'@directus/system-data': patch
'@directus/app': minor
---

Added shareable Flow debug sessions: start a session with test input, inspect every node's redacted output, rerun a failed branch from any node, cancel running sessions, and label the session as succeeded, failed, or cancelled. Sessions stream progress over the existing realtime subscription, sensitive input/output follows the existing flow log redaction rules, and ownership/flow permissions are enforced on every action.
