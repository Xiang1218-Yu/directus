---
'@directus/api': minor
'@directus/app': minor
'@directus/env': minor
'@directus/types': minor
'@directus/system-data': minor
---

Added optional content-addressed file deduplication. When `FILES_DEDUPE_ENABLED` is set to `true`, uploads are hashed while streaming to storage (`FILES_DEDUPE_ALGORITHM`, default `sha256`) and the checksum is stored on the `directus_files` record. If an identical object already exists in the same storage location, the new file record reuses it instead of storing a second copy. Physical objects are only deleted once no file record references them anymore, and resumable (TUS) uploads are deduplicated on completion. Existing files can be backfilled with `directus files checksums:backfill`.

::: notice

Deduplication is opt-in via `FILES_DEDUPE_ENABLED=true`. The upload response exposes the outcome through the `Directus-Dedupe-Status` (`reused`, `stored`, `bypassed`, `failed`) and `Directus-File-Checksum` headers, and the file's `checksum` field is visible in the API and Studio.

:::
