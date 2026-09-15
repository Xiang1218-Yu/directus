---
'@directus/api': minor
---

Added a read-only `schema diff` CLI command that compares the current database against a JSON/YAML snapshot file, or two snapshot files against each other, and reports the differing collections, fields, system fields and relations in human readable or stable machine readable (`--format json`) output

::: notice

`directus schema diff <path> [otherPath]` never modifies the database and never prompts to apply changes. It exits with code `0` when no differences are found, `1` when differences are found, `2` when a snapshot file does not exist, `3` when a snapshot file is invalid and `4` on unexpected errors, and supports `--ignoreRules` to filter out specific collections and fields.

:::
