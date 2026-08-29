import type Database from '../../../../sqlite/sync-database'

const LIFECYCLE_STATE_SQL = `
  CHECK(lifecycle_state IN (
    'owned', 'retained', 'release_requested', 'release_closing', 'release_unknown',
    'contained', 'released', 'transferred', 'user_owned', 'external'
  ))`

export function workerExecutionLifecycleTableSql(ifNotExists = true): string {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}worker_execution_resources (
  id                       TEXT PRIMARY KEY,
  origin_dispatch_id       TEXT NOT NULL,
  owner_dispatch_id        TEXT NOT NULL,
  prior_owner_dispatch_ids TEXT NOT NULL DEFAULT '[]',
  worktree_id              TEXT,
  resource_kind            TEXT NOT NULL CHECK(resource_kind = 'terminal'),
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

const WORKER_EXECUTION_LIFECYCLE_INDEXES_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_execution_resources_owner
  ON worker_execution_resources(owner_dispatch_id);
CREATE INDEX IF NOT EXISTS idx_worker_execution_resources_terminal
  ON worker_execution_resources(terminal_handle);
CREATE INDEX IF NOT EXISTS idx_worker_execution_resources_terminal_identity
  ON worker_execution_resources(process_incarnation, host_scope);
CREATE INDEX IF NOT EXISTS idx_worker_execution_resources_lifecycle
  ON worker_execution_resources(lifecycle_state);`

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  )
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return columns.some((candidate) => candidate.name === column)
}

export function ensureWorkerExecutionLifecycleIndexes(db: Database.Database): void {
  if (hasTable(db, 'worker_execution_resources')) {
    db.exec(WORKER_EXECUTION_LIFECYCLE_INDEXES_SQL)
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

export function migrateWorkerExecutionLifecycleV31(db: Database.Database): void {
  const hasExecutionResources = hasTable(db, 'worker_execution_resources')
  const hasLegacyTerminalResources = hasTable(db, 'worker_terminal_resources')
  if (hasExecutionResources && !hasLegacyTerminalResources) {
    ensureWorkerExecutionLifecycleIndexes(db)
    return
  }
  if (!hasLegacyTerminalResources) {
    db.exec(workerExecutionLifecycleTableSql())
    ensureWorkerExecutionLifecycleIndexes(db)
    return
  }
  if (hasExecutionResources) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM worker_execution_resources').get() as {
      count: number
    }
    if (count.count !== 0) {
      throw new Error('Conflicting worker execution and legacy terminal resources')
    }
    db.exec('DROP TABLE worker_execution_resources')
  }
  const lifecycleExpression = hasColumn(db, 'worker_terminal_resources', 'lifecycle_state')
    ? 'lifecycle_state'
    : LEGACY_STATE_MAPPING_SQL
  const unmappable = db
    .prepare(
      `SELECT id
         FROM worker_terminal_resources
        WHERE (${lifecycleExpression}) IS NULL
        LIMIT 1`
    )
    .get() as { id: string } | undefined
  if (unmappable) {
    throw new Error(`Unmappable worker execution lifecycle for ${unmappable.id}`)
  }

  db.exec(`
    ALTER TABLE worker_terminal_resources RENAME TO worker_terminal_resources_v30;
    ${workerExecutionLifecycleTableSql(false)}
    INSERT INTO worker_execution_resources (
      id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, worktree_id,
      resource_kind, terminal_handle, pane_key, process_incarnation, host_scope,
      lifecycle_state, retained_reason, release_requested_at, release_completed_at,
      release_error, archive_source, archive_status, created_at, updated_at
    )
    SELECT
      id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, worktree_id,
      'terminal', terminal_handle, pane_key, process_incarnation, host_scope,
      ${lifecycleExpression}, retained_reason, release_requested_at, release_completed_at,
      release_error, archive_source, archive_status, created_at, updated_at
    FROM worker_terminal_resources_v30;
    DROP TABLE worker_terminal_resources_v30;
    ${WORKER_EXECUTION_LIFECYCLE_INDEXES_SQL}
  `)
}
