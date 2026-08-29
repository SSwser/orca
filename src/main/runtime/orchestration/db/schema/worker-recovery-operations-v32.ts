import type Database from '../../../../sqlite/sync-database'

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  )
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (candidate) => candidate.name === column
  )
}

export function workerGenerationOperationsTableV32Sql(): string {
  return `
CREATE TABLE IF NOT EXISTS worker_generation_operations (
  dispatch_id         TEXT NOT NULL,
  effect_kind         TEXT NOT NULL
    CHECK(effect_kind IN ('worktree', 'execution_start')),
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

function generationOperationsAreCanonical(db: Database.Database): boolean {
  if (!hasTable(db, 'worker_generation_operations')) {
    return true
  }
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get('worker_generation_operations') as { sql?: string } | undefined
  return Boolean(
    row?.sql?.includes("'execution_start'") &&
    !row.sql.includes("'terminal'") &&
    !row.sql.includes("'prompt'")
  )
}

function rebuildGenerationOperations(db: Database.Database): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_worker_generation_operations_state;
    ALTER TABLE worker_generation_operations RENAME TO worker_generation_operations_legacy;
    ${workerGenerationOperationsTableV32Sql()}
    INSERT INTO worker_generation_operations (
      dispatch_id, effect_kind, operation_id, payload_fingerprint, state,
      claimant_id, receipt, created_at, updated_at
    )
    SELECT dispatch_id, effect_kind, operation_id, payload_fingerprint, state,
           claimant_id, receipt, created_at, updated_at
      FROM worker_generation_operations_legacy
     WHERE effect_kind = 'worktree';
    DROP TABLE worker_generation_operations_legacy;
  `)
}

function recoveryDispositionIsCanonical(db: Database.Database): boolean {
  const columns = db.prepare('PRAGMA table_info(worker_lost_custody_recoveries)').all() as {
    name: string
  }[]
  return columns.some((column) => column.name === 'disposition')
}

function rebuildRecoveriesWithDisposition(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS trg_worker_recovery_record_successor_worktree;
    ALTER TABLE worker_lost_custody_recoveries RENAME TO worker_lost_custody_recoveries_v31;
    CREATE TABLE worker_lost_custody_recoveries (
      id                       TEXT PRIMARY KEY,
      run_id                   TEXT NOT NULL,
      task_id                  TEXT NOT NULL,
      source_dispatch_id       TEXT NOT NULL UNIQUE,
      source_resource_id       TEXT NOT NULL UNIQUE,
      source_delivery_id       TEXT NOT NULL UNIQUE,
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
    INSERT INTO worker_lost_custody_recoveries (
      id, run_id, task_id, source_dispatch_id, source_resource_id, source_delivery_id,
      source_worktree_id, disposition, trusted_revision, successor_dispatch_id,
      successor_worktree_id, successor_placement, successor_name, authorization,
      mutation_caller_fingerprint, mutation_request_id, created_at
    )
    SELECT id, run_id, task_id, source_dispatch_id, source_resource_id, source_delivery_id,
           source_worktree_id, 'retry_with_successor', trusted_revision, successor_dispatch_id,
           successor_worktree_id, successor_placement, successor_name, authorization,
           mutation_caller_fingerprint, mutation_request_id, created_at
      FROM worker_lost_custody_recoveries_v31;
    DROP TABLE worker_lost_custody_recoveries_v31;
    CREATE INDEX idx_worker_lost_custody_recoveries_run
      ON worker_lost_custody_recoveries(run_id, created_at);
    CREATE INDEX idx_worker_lost_custody_recoveries_task
      ON worker_lost_custody_recoveries(task_id, created_at);
    CREATE TRIGGER trg_worker_recovery_record_successor_worktree
    AFTER UPDATE OF worktree_id ON worker_dispatches
    WHEN NEW.worktree_id IS NOT NULL
    BEGIN
      UPDATE worker_lost_custody_recoveries
         SET successor_worktree_id = NEW.worktree_id
       WHERE successor_dispatch_id = NEW.dispatch_id;
    END;
  `)
}

function migrateWorkerExecutionCapacityDebtsV32(db: Database.Database): void {
  const currentTable = 'worker_execution_capacity_debts'
  const legacyTable = 'worker_terminal_capacity_debts'
  if (!hasTable(db, legacyTable)) {
    return
  }
  if (hasTable(db, currentTable)) {
    const current = db.prepare(`SELECT COUNT(*) AS count FROM ${currentTable}`).get() as {
      count: number
    }
    if (current.count !== 0) {
      throw new Error('Conflicting worker execution and legacy terminal capacity debts')
    }
    db.exec(`DROP TABLE ${currentTable}`)
  }
  db.exec(`ALTER TABLE ${legacyTable} RENAME TO ${currentTable}`)
}

export function migrateWorkerRecoveryOperationsV32(db: Database.Database): void {
  migrateWorkerExecutionCapacityDebtsV32(db)
  if (!hasColumn(db, 'worker_dispatches', 'provisional_capability')) {
    db.exec('ALTER TABLE worker_dispatches ADD COLUMN provisional_capability TEXT')
  }
  if (!recoveryDispositionIsCanonical(db)) {
    rebuildRecoveriesWithDisposition(db)
  }
  if (generationOperationsAreCanonical(db)) {
    db.exec(workerGenerationOperationsTableV32Sql())
  } else {
    rebuildGenerationOperations(db)
  }
}
