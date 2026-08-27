import type Database from '../../../../sqlite/sync-database'

const LIFECYCLE_STATE_SQL = `
  CHECK(lifecycle_state IN (
    'owned', 'retained', 'release_requested', 'release_closing', 'release_unknown',
    'contained', 'released', 'transferred', 'user_owned', 'external'
  ))`

export function workerTerminalLifecycleTableSql(ifNotExists = true): string {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}worker_terminal_resources (
  id                       TEXT PRIMARY KEY,
  origin_dispatch_id       TEXT NOT NULL,
  owner_dispatch_id        TEXT NOT NULL,
  prior_owner_dispatch_ids TEXT NOT NULL DEFAULT '[]',
  worktree_id              TEXT,
  terminal_handle          TEXT NOT NULL,
  pane_key                 TEXT,
  process_incarnation      TEXT,
  host_scope               TEXT,
  lifecycle_state          TEXT NOT NULL DEFAULT 'owned' ${LIFECYCLE_STATE_SQL},
  retained_reason          TEXT,
  release_requested_at     TEXT,
  release_completed_at     TEXT,
  release_error            TEXT,
  archive_source           TEXT,
  archive_status           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);`
}

const WORKER_TERMINAL_LIFECYCLE_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_terminal_resources_owner
  ON worker_terminal_resources(owner_dispatch_id);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_handle
  ON worker_terminal_resources(terminal_handle);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_pane
  ON worker_terminal_resources(pane_key);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_identity
  ON worker_terminal_resources(process_incarnation, host_scope);
CREATE INDEX IF NOT EXISTS idx_worker_terminal_resources_lifecycle
  ON worker_terminal_resources(lifecycle_state);`

function hasWorkerTerminalColumn(db: Database.Database, column: string): boolean {
  const columns = db.prepare('PRAGMA table_info(worker_terminal_resources)').all() as {
    name: string
  }[]
  return columns.some((candidate) => candidate.name === column)
}

export function ensureWorkerTerminalLifecycleIndexes(db: Database.Database): void {
  if (hasWorkerTerminalColumn(db, 'lifecycle_state')) {
    db.exec(WORKER_TERMINAL_LIFECYCLE_INDEXES_SQL)
  }
}

const LEGACY_STATE_MAPPING_SQL = `CASE
  WHEN ownership_state = 'released' OR release_state = 'released' THEN 'released'
  WHEN ownership_state = 'transferred' THEN 'transferred'
  WHEN ownership_state = 'user_owned' THEN 'user_owned'
  WHEN ownership_state = 'external' THEN 'external'
  WHEN ownership_state = 'owned' AND release_state = 'unknown' THEN 'release_unknown'
  WHEN ownership_state = 'owned' AND release_state = 'releasing' THEN 'release_closing'
  WHEN ownership_state = 'owned' AND release_state = 'requested' THEN 'release_requested'
  WHEN ownership_state = 'owned' AND release_state = 'retained' THEN 'retained'
  WHEN ownership_state = 'owned' AND release_state = 'not_requested' THEN 'owned'
END`

export function migrateWorkerTerminalLifecycleV31(db: Database.Database): void {
  if (hasWorkerTerminalColumn(db, 'lifecycle_state')) {
    ensureWorkerTerminalLifecycleIndexes(db)
    return
  }
  const unmappable = db
    .prepare(
      `SELECT id, ownership_state, release_state
         FROM worker_terminal_resources
        WHERE (${LEGACY_STATE_MAPPING_SQL}) IS NULL
        LIMIT 1`
    )
    .get() as { id: string; ownership_state: string; release_state: string } | undefined
  if (unmappable) {
    throw new Error(
      `Unmappable worker terminal lifecycle for ${unmappable.id}: ${unmappable.ownership_state}/${unmappable.release_state}`
    )
  }

  db.exec(`
    ALTER TABLE worker_terminal_resources RENAME TO worker_terminal_resources_v29;
    ${workerTerminalLifecycleTableSql(false)}
    INSERT INTO worker_terminal_resources (
      id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, worktree_id,
      terminal_handle, pane_key, process_incarnation, host_scope, lifecycle_state,
      retained_reason, release_requested_at, release_completed_at, release_error,
      archive_source, archive_status, created_at, updated_at
    )
    SELECT
      id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, worktree_id,
      terminal_handle, pane_key, process_incarnation, host_scope,
      ${LEGACY_STATE_MAPPING_SQL},
      retained_reason, release_requested_at, release_completed_at, release_error,
      archive_source, archive_status, created_at, updated_at
    FROM worker_terminal_resources_v29;
    DROP TABLE worker_terminal_resources_v29;
    ${WORKER_TERMINAL_LIFECYCLE_INDEXES_SQL}
  `)
}
