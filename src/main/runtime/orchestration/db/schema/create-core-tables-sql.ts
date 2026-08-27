import { LEGACY_RUN_ID } from '../contract-constants'
import { workerContainmentRecoveryTablesV32Sql } from './worker-containment-recovery-v31'
import { workerTerminalLifecycleTableSql } from './worker-terminal-lifecycle-v31'

export function createCoreTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS runs (
  id                    TEXT PRIMARY KEY,
  objective             TEXT NOT NULL,
  home_database         TEXT NOT NULL DEFAULT 'this_database',
  coordinator_handle    TEXT,
  coordinator_pane_key  TEXT,
  consumer_generation   INTEGER NOT NULL DEFAULT 0,
  legacy                INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT NOT NULL,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
    CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')),
  from_handle   TEXT NOT NULL,
  to_handle     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'status'
    CHECK(type IN (
      'status', 'dispatch', 'worker_done', 'merge_ready',
      'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
    )),
  priority      TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('normal', 'high', 'urgent')),
  thread_id     TEXT,
  payload       TEXT,
  read          INTEGER NOT NULL DEFAULT 0,
  sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at  TEXT,
  sender_pane_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_id ON messages(id);
CREATE INDEX IF NOT EXISTS idx_inbox ON messages(to_handle, read);
CREATE INDEX IF NOT EXISTS idx_thread ON messages(thread_id);

CREATE TABLE IF NOT EXISTS run_coordinator_handles (
  run_id          TEXT NOT NULL,
  terminal_handle TEXT NOT NULL,
  first_bound_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, terminal_handle)
);

CREATE INDEX IF NOT EXISTS idx_run_coordinator_handles_handle
  ON run_coordinator_handles(terminal_handle, run_id);

CREATE TRIGGER IF NOT EXISTS trg_runs_remember_coordinator_insert
AFTER INSERT ON runs
WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
  VALUES (NEW.id, NEW.coordinator_handle);
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_remember_coordinator_update
AFTER UPDATE OF coordinator_handle ON runs
WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
  VALUES (NEW.id, NEW.coordinator_handle);
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_forget_coordinator_handles
AFTER DELETE ON runs
BEGIN
  DELETE FROM run_coordinator_handles WHERE run_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS deliveries (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  consumer_generation   INTEGER NOT NULL,
  message_ids           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'outstanding'
    CHECK(status IN ('outstanding', 'acknowledged', 'fenced', 'contained')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
  ON deliveries(run_id) WHERE status = 'outstanding';
CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
  ON deliveries(run_id, created_at);

CREATE TABLE IF NOT EXISTS mutation_receipts (
  caller_fingerprint  TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  method              TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'completed')),
  receipt             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (caller_fingerprint, request_id)
);

CREATE TABLE IF NOT EXISTS mutation_caller_identities (
  transport           TEXT PRIMARY KEY,
  caller_fingerprint  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS worker_dispatches (
  dispatch_id            TEXT PRIMARY KEY,
  runtime_epoch          TEXT,
  state                  TEXT NOT NULL DEFAULT 'starting'
    CHECK(state IN (
      'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
      'stopping', 'stop_unknown', 'stopped', 'abandoned'
    )),
  stage                  TEXT NOT NULL DEFAULT 'accepted',
  worktree_id            TEXT,
  agent_terminal_handle  TEXT,
  setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
  effects                TEXT NOT NULL DEFAULT '[]',
  residual_resources     TEXT NOT NULL DEFAULT '[]',
  start_options          TEXT NOT NULL DEFAULT '{}',
  last_error             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

${workerTerminalLifecycleTableSql()}

CREATE TABLE IF NOT EXISTS worker_terminal_archives (
  dispatch_id   TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK(kind IN ('transcript_pin', 'terminal_tail')),
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

${workerContainmentRecoveryTablesV32Sql()}

  `
}
