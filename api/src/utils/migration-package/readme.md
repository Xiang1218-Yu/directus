# Schema migration packages

A migration package is a reviewable, replayable artifact describing the ordered schema changes between two snapshots. It
is produced by the existing `getSnapshotDiff` infrastructure and applied through the existing `applyDiff`
infrastructure, one step per transaction.

## CLI

```sh
# Generate a package from a target snapshot, diffed against the live database.
# By default the package also contains rollback steps (the reverse diff).
directus schema package create target.yaml ./migrations/2026-09-add-posts.yaml \
  --id 2026-09-add-posts --author ci --description "Add posts collection"

# Generate purely from files (no database connection needed)
directus schema package create target.json --from source.json --format json package.json

# Omit rollback steps for a forward-only package (--no-rollback)
directus schema package create target.json package.json --no-rollback

# Read-only compatibility checks against the target database (safe for CI)
directus schema package check ./migrations/2026-09-add-posts.yaml
directus schema package check --rollback ./migrations/2026-09-add-posts.yaml
directus schema package apply ./migrations/2026-09-add-posts.yaml --dry-run

# Apply (completed steps are tracked and skipped on re-runs)
directus schema package apply ./migrations/2026-09-add-posts.yaml --yes

# Undo an applied package back to its source snapshot
directus schema package rollback ./migrations/2026-09-add-posts.yaml --dry-run
directus schema package rollback ./migrations/2026-09-add-posts.yaml --yes
```

The legacy `directus schema snapshot` and `directus schema apply` commands are unchanged.

## Format

JSON or YAML (detected from the file extension). Top-level envelope:

```yaml
kind: directus.schema-migration-package
version: 1
id: 2026-09-add-posts # unique bookkeeping key, [A-Za-z0-9._-]
metadata:
  createdAt: 2026-09-15T00:00:00.000Z
  author: ci # optional
  description: Add posts # optional, shown in review
from: { version: 1, directus: 11.0.0, vendor: postgres }
to: { version: 1, directus: 11.0.0, vendor: postgres }
fromHash: <object hash of the source snapshot> # optional, advisory
toHash: <object hash of the target snapshot> # optional, advisory
steps:
  - id: 0001-create-collection-posts
    name: create collection posts
    kind: create-collection
    collection: posts
    diff: { collections: [...], fields: [], systemFields: [], relations: [] }
# Reverse plan: getSnapshotDiff(to, from), split into steps the same way
rollback:
  - id: 0001-delete-collection-posts
    name: delete collection posts
    kind: delete-collection
    collection: posts
    diff: { collections: [...], fields: [], systemFields: [], relations: [] }
```

### Step rules

- Step ids are `NNNN-<kind>-<target>` with a gap-free, zero-padded numeric prefix that defines execution order. Forward
  and rollback ids are independent lists (each numbered from `0001`).
- A step contains exactly one diff entry — except `create-collection`, which bundles the collection with its new fields
  (mirroring `applyDiff`, which creates the primary key together with the collection).
- Kinds: `create-collection`, `update-collection`, `delete-collection`, `create-field`, `update-field`, `delete-field`,
  `update-system-field`, `create-relation`, `update-relation`, `delete-relation`.
- The kind must match the deep-diff kind (`N`/`D`/`E`/`A`) and section of its entry. A `NEW`/`DELETE` diff whose path
  starts at `meta` is a meta-only change on an existing field and becomes a single `update-field` step (it is never
  split into create + update).
- Malformed packages are rejected before any database access.

### Step order (both directions)

1. create-collection (parent groups before nested collections)
2. delete-collection
3. update-collection
4. create-field → update-field → delete-field
5. update-system-field
6. create-relation → update-relation → delete-relation

## Application semantics and failure handling

- **Compatibility check first**: the current snapshot is read and every pending step checked for create-already-exists /
  update-or-delete-missing conflicts. Hard conflicts abort before any write. Source-hash mismatch and prior runs are
  reported as warnings.
- **Transactions**: each step and its progress row are committed in a single transaction. A failing step rolls back
  completely; previously committed steps stay in place. The failure is recorded in its own transaction.
- **Resumability & idempotency**: progress is tracked per direction (`up` / `down`) in `directus_schema_migration_steps`
  (created lazily). Re-running skips completed steps and resumes at the first pending/failed step.
- **Duplicate execution**: applying a fully applied package prints the plan and exits without changes.
- **`--dry-run` / `check`**: runs only the read-only check and prints the plan; it never creates the bookkeeping table
  nor writes any schema change or progress row.

## Rollback semantics

- `rollback` steps are generated from `getSnapshotDiff(to, from)` — the exact inverse transition computed the same way
  as the forward plan, so collection deletions correctly recreate their fields and relations.
- A rollback refuses to run when the forward package has not been fully applied, when the package has no `rollback`
  steps, or when any pending rollback step has a hard conflict against the current schema.
- Rollback progress is tracked independently and is itself resumable.
- Once the rollback completes fully, bookkeeping for both directions is cleared, leaving the package in a pristine state
  so it can be applied again.
