---
'@directus/api': minor
---

Added reviewable schema migration packages (`directus schema package create|check|apply|rollback`) that split a snapshot diff into ordered, transactional, resumable steps with metadata, supporting JSON, YAML and built-in rollback steps
