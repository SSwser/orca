import type Database from '../../../../sqlite/sync-database'

export function workerContainmentRecoveryTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS worker_lost_custody_recoveries (
  id                       TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL,
  task_id                  TEXT NOT NULL,
  source_dispatch_id       TEXT NOT NULL UNIQUE,
  source_resource_id       TEXT NOT NULL UNIQUE,
  source_delivery_id       TEXT NOT NULL UNIQUE,
  source_worktree_id       TEXT NOT NULL,
  trusted_revision         TEXT NOT NULL,
  successor_dispatch_id    TEXT NOT NULL UNIQUE,
  successor_worktree_id    TEXT,
  successor_placement      TEXT NOT NULL
    CHECK(successor_placement IN ('new-child', 'new-top-level')),
  successor_name           TEXT NOT NULL,
  authorization            TEXT NOT NULL
    CHECK(authorization = 'acknowledge_possible_duplicate_external_effects'),
  mutation_caller_fingerprint TEXT NOT NULL,
  mutation_request_id      TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mutation_caller_fingerprint, mutation_request_id)
);

CREATE INDEX IF NOT EXISTS idx_worker_lost_custody_recoveries_run
  ON worker_lost_custody_recoveries(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_worker_lost_custody_recoveries_task
  ON worker_lost_custody_recoveries(task_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_worker_recovery_record_successor_worktree
AFTER UPDATE OF worktree_id ON worker_dispatches
WHEN NEW.worktree_id IS NOT NULL
BEGIN
  UPDATE worker_lost_custody_recoveries
     SET successor_worktree_id = NEW.worktree_id
   WHERE successor_dispatch_id = NEW.dispatch_id;
END;

CREATE TABLE IF NOT EXISTS worker_workspace_generation_fences (
  worktree_id         TEXT PRIMARY KEY,
  source_resource_id TEXT NOT NULL UNIQUE,
  recovery_id        TEXT NOT NULL UNIQUE,
  reason             TEXT NOT NULL CHECK(reason = 'lost_custody'),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_terminal_capacity_debts (
  resource_id  TEXT PRIMARY KEY,
  recovery_id  TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL DEFAULT 'withheld' CHECK(state IN ('withheld', 'released')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  released_at  TEXT
);`
}

// Fresh databases start at the canonical disposition-aware shape; the v31 function above remains
// the source shape used only while upgrading existing profiles.
export function workerContainmentRecoveryTablesV32Sql(): string {
  return `
CREATE TABLE IF NOT EXISTS worker_lost_custody_recoveries (
  id                       TEXT PRIMARY KEY,
  run_id                   TEXT NOT NULL,
  task_id                  TEXT NOT NULL,
  source_dispatch_id       TEXT NOT NULL UNIQUE,
  source_resource_id       TEXT NOT NULL UNIQUE,
  source_delivery_id      TEXT NOT NULL UNIQUE,
  source_worktree_id       TEXT NOT NULL,
  disposition              TEXT NOT NULL
    CHECK(disposition IN ('accept_archived_result', 'retry_with_successor')),
  trusted_revision         TEXT,
  successor_dispatch_id    TEXT UNIQUE,
  successor_worktree_id    TEXT,
  successor_placement      TEXT
    CHECK(successor_placement IN ('new-child', 'new-top-level')),
  successor_name           TEXT,
  authorization            TEXT NOT NULL
    CHECK(authorization IN (
      'accept_authoritative_archived_result_with_lost_custody',
      'acknowledge_possible_duplicate_external_effects'
    )),
  mutation_caller_fingerprint TEXT NOT NULL,
  mutation_request_id      TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(mutation_caller_fingerprint, mutation_request_id),
  CHECK(
    (disposition = 'accept_archived_result'
      AND trusted_revision IS NULL
      AND successor_dispatch_id IS NULL
      AND successor_placement IS NULL
      AND successor_name IS NULL
      AND authorization = 'accept_authoritative_archived_result_with_lost_custody')
    OR
    (disposition = 'retry_with_successor'
      AND trusted_revision IS NOT NULL
      AND successor_dispatch_id IS NOT NULL
      AND successor_placement IS NOT NULL
      AND successor_name IS NOT NULL
      AND authorization = 'acknowledge_possible_duplicate_external_effects')
  )
);
CREATE INDEX IF NOT EXISTS idx_worker_lost_custody_recoveries_run
  ON worker_lost_custody_recoveries(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_worker_lost_custody_recoveries_task
  ON worker_lost_custody_recoveries(task_id, created_at);
CREATE TRIGGER IF NOT EXISTS trg_worker_recovery_record_successor_worktree
AFTER UPDATE OF worktree_id ON worker_dispatches
WHEN NEW.worktree_id IS NOT NULL
BEGIN
  UPDATE worker_lost_custody_recoveries
     SET successor_worktree_id = NEW.worktree_id
   WHERE successor_dispatch_id = NEW.dispatch_id;
END;
CREATE TABLE IF NOT EXISTS worker_workspace_generation_fences (
  worktree_id         TEXT PRIMARY KEY,
  source_resource_id TEXT NOT NULL UNIQUE,
  recovery_id        TEXT NOT NULL UNIQUE,
  reason             TEXT NOT NULL CHECK(reason = 'lost_custody'),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS worker_terminal_capacity_debts (
  resource_id  TEXT PRIMARY KEY,
  recovery_id  TEXT NOT NULL UNIQUE,
  state        TEXT NOT NULL DEFAULT 'withheld' CHECK(state IN ('withheld', 'released')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  released_at  TEXT
);
CREATE TABLE IF NOT EXISTS worker_generation_operations (
  dispatch_id         TEXT NOT NULL,
  effect_kind         TEXT NOT NULL
    CHECK(effect_kind IN ('worktree', 'terminal', 'authority', 'prompt')),
  operation_id        TEXT NOT NULL UNIQUE,
  payload_fingerprint TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'claimed'
    CHECK(state IN ('claimed', 'completed', 'unverifiable')),
  claimant_id         TEXT NOT NULL,
  receipt             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(dispatch_id, effect_kind)
);
CREATE INDEX IF NOT EXISTS idx_worker_generation_operations_state
  ON worker_generation_operations(state, updated_at);`
}

function deliveriesSupportContainment(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'")
    .get() as { sql: string } | undefined
  return Boolean(row?.sql.includes("'contained'"))
}

function rebuildDeliveriesForContainment(db: Database.Database): void {
  db.exec(`
    ALTER TABLE deliveries RENAME TO deliveries_v29;
    CREATE TABLE deliveries (
      id                    TEXT PRIMARY KEY,
      run_id                TEXT NOT NULL,
      consumer_generation   INTEGER NOT NULL,
      message_ids           TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'outstanding'
        CHECK(status IN ('outstanding', 'acknowledged', 'fenced', 'contained')),
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at       TEXT
    );
    INSERT INTO deliveries (
      id, run_id, consumer_generation, message_ids, status, created_at, acknowledged_at
    )
    SELECT id, run_id, consumer_generation, message_ids, status, created_at, acknowledged_at
      FROM deliveries_v29;
    DROP TABLE deliveries_v29;
    CREATE UNIQUE INDEX idx_deliveries_one_outstanding
      ON deliveries(run_id) WHERE status = 'outstanding';
    CREATE INDEX idx_deliveries_run_created
      ON deliveries(run_id, created_at);
  `)
}

export function migrateWorkerContainmentRecoveryV31(db: Database.Database): void {
  if (!deliveriesSupportContainment(db)) {
    rebuildDeliveriesForContainment(db)
  }
  db.exec(workerContainmentRecoveryTablesSql())
}
