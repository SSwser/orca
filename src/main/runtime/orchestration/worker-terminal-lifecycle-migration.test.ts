import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { migrateWorkerTerminalLifecycleV31 } from './db/schema/worker-terminal-lifecycle-v31'
import { workerContainmentRecoveryTablesSql } from './db/schema/worker-containment-recovery-v31'
import { migrateWorkerRecoveryOperationsV32 } from './db/schema/worker-recovery-operations-v32'

type LegacyResource = {
  id: string
  ownership: string
  release: string
}

const LEGACY_RESOURCES: LegacyResource[] = [
  { id: 'ownership_released', ownership: 'released', release: 'unknown' },
  { id: 'release_released', ownership: 'owned', release: 'released' },
  { id: 'transferred', ownership: 'transferred', release: 'unknown' },
  { id: 'user_owned', ownership: 'user_owned', release: 'releasing' },
  { id: 'external', ownership: 'external', release: 'requested' },
  { id: 'release_unknown', ownership: 'owned', release: 'unknown' },
  { id: 'release_closing', ownership: 'owned', release: 'releasing' },
  { id: 'release_requested', ownership: 'owned', release: 'requested' },
  { id: 'retained', ownership: 'owned', release: 'retained' },
  { id: 'owned', ownership: 'owned', release: 'not_requested' }
]

describe('worker terminal lifecycle migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function createV29Database(resources = LEGACY_RESOURCES): string {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-worker-lifecycle-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE worker_terminal_resources (
        id                       TEXT PRIMARY KEY,
        origin_dispatch_id       TEXT NOT NULL,
        owner_dispatch_id        TEXT NOT NULL,
        prior_owner_dispatch_ids TEXT NOT NULL DEFAULT '[]',
        worktree_id              TEXT,
        terminal_handle          TEXT NOT NULL,
        pane_key                 TEXT,
        process_incarnation      TEXT,
        host_scope               TEXT,
        ownership_state          TEXT NOT NULL,
        release_state            TEXT NOT NULL,
        retained_reason          TEXT,
        release_requested_at     TEXT,
        release_completed_at     TEXT,
        release_error            TEXT,
        archive_source           TEXT,
        archive_status           TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_worker_terminal_resources_owner
        ON worker_terminal_resources(owner_dispatch_id);
      CREATE INDEX idx_worker_terminal_resources_handle
        ON worker_terminal_resources(terminal_handle);
      CREATE INDEX idx_worker_terminal_resources_pane
        ON worker_terminal_resources(pane_key);
      CREATE INDEX idx_worker_terminal_resources_identity
        ON worker_terminal_resources(process_incarnation, host_scope);
      CREATE INDEX idx_worker_terminal_resources_release
        ON worker_terminal_resources(release_state);
    `)
    const insert = raw.prepare(`
      INSERT INTO worker_terminal_resources (
        id, origin_dispatch_id, owner_dispatch_id, prior_owner_dispatch_ids, worktree_id,
        terminal_handle, pane_key, process_incarnation, host_scope, ownership_state,
        release_state, retained_reason, release_requested_at, release_completed_at,
        release_error, archive_source, archive_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const resource of resources) {
      insert.run(
        resource.id,
        `origin_${resource.id}`,
        `owner_${resource.id}`,
        JSON.stringify([`prior_${resource.id}`]),
        `worktree_${resource.id}`,
        `terminal_${resource.id}`,
        `tab_${resource.id}:leaf`,
        `process_${resource.id}`,
        'local',
        resource.ownership,
        resource.release,
        'identity_unproven',
        '2026-08-20 01:00:00',
        '2026-08-20 02:00:00',
        `error_${resource.id}`,
        'worker_read',
        'captured',
        '2026-08-20 00:00:00',
        '2026-08-20 03:00:00'
      )
    }
    raw.pragma('user_version = 29')
    raw.close()
    return dbPath
  }

  it('maps every v29 state with precedence and preserves resource evidence', () => {
    const dbPath = createV29Database()
    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(32)
    expect(SCHEMA_VERSION).toBe(32)
    const columns = sqlite.prepare('PRAGMA table_info(worker_terminal_resources)').all() as {
      name: string
    }[]
    expect(columns.map((column) => column.name)).toContain('lifecycle_state')
    expect(columns.map((column) => column.name)).not.toContain('ownership_state')
    expect(columns.map((column) => column.name)).not.toContain('release_state')

    const rows = sqlite
      .prepare(
        `SELECT id, lifecycle_state, origin_dispatch_id, owner_dispatch_id,
                prior_owner_dispatch_ids, worktree_id, terminal_handle, pane_key,
                process_incarnation, host_scope, retained_reason, release_requested_at,
                release_completed_at, release_error, archive_source, archive_status,
                created_at, updated_at
           FROM worker_terminal_resources ORDER BY id`
      )
      .all() as Record<string, string>[]
    expect(Object.fromEntries(rows.map((row) => [row.id, row.lifecycle_state]))).toEqual({
      external: 'external',
      owned: 'owned',
      ownership_released: 'released',
      release_closing: 'release_closing',
      release_released: 'released',
      release_requested: 'release_requested',
      release_unknown: 'release_unknown',
      retained: 'retained',
      transferred: 'transferred',
      user_owned: 'user_owned'
    })
    expect(rows.find((row) => row.id === 'release_unknown')).toMatchObject({
      origin_dispatch_id: 'origin_release_unknown',
      owner_dispatch_id: 'owner_release_unknown',
      prior_owner_dispatch_ids: '["prior_release_unknown"]',
      worktree_id: 'worktree_release_unknown',
      terminal_handle: 'terminal_release_unknown',
      pane_key: 'tab_release_unknown:leaf',
      process_incarnation: 'process_release_unknown',
      host_scope: 'local',
      retained_reason: 'identity_unproven',
      release_requested_at: '2026-08-20 01:00:00',
      release_completed_at: '2026-08-20 02:00:00',
      release_error: 'error_release_unknown',
      archive_source: 'worker_read',
      archive_status: 'captured',
      created_at: '2026-08-20 00:00:00',
      updated_at: '2026-08-20 03:00:00'
    })
    const indexes = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'worker_terminal_resources'`
      )
      .all() as { name: string }[]
    expect(indexes.map((row) => row.name)).toContain('idx_worker_terminal_resources_lifecycle')
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('worker_lost_custody_recoveries', 'worker_workspace_generation_fences', 'worker_terminal_capacity_debts') ORDER BY name"
        )
        .all()
    ).toEqual([
      { name: 'worker_lost_custody_recoveries' },
      { name: 'worker_terminal_capacity_debts' },
      { name: 'worker_workspace_generation_fences' }
    ])
    const recoveryColumns = sqlite
      .prepare('PRAGMA table_info(worker_lost_custody_recoveries)')
      .all() as { name: string }[]
    expect(recoveryColumns.map((column) => column.name)).toContain('successor_worktree_id')
    expect(recoveryColumns.map((column) => column.name)).toContain('disposition')
    expect(
      sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_generation_operations'"
        )
        .get()
    ).toEqual({ name: 'worker_generation_operations' })
    const deliveriesSql = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'")
      .get() as { sql: string }
    expect(deliveriesSql.sql).toContain("'contained'")
  })

  it('creates fresh databases directly with the canonical v32 recovery schema', () => {
    db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    const recovery = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worker_lost_custody_recoveries'"
      )
      .get() as { sql: string }
    const operations = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worker_generation_operations'"
      )
      .get() as { sql: string }

    expect(recovery.sql).toContain('disposition')
    expect(recovery.sql).not.toContain('ownership_state')
    expect(recovery.sql).not.toContain('release_state')
    expect(operations.sql).toContain('state')
  })

  it('rolls back and keeps v29 intact when a legacy state is unmappable', () => {
    const dbPath = createV29Database([
      { id: 'invalid', ownership: 'owned', release: 'future_state' }
    ])
    const raw = new Database(dbPath)
    let migrationError: unknown
    raw.exec('BEGIN IMMEDIATE')
    try {
      migrateWorkerTerminalLifecycleV31(raw)
      raw.pragma('user_version = 30')
      raw.exec('COMMIT')
    } catch (error) {
      migrationError = error
      raw.exec('ROLLBACK')
    }
    expect(migrationError).toMatchObject({
      message: expect.stringMatching(/unmappable worker terminal lifecycle/i)
    })
    expect(raw.pragma('user_version', { simple: true })).toBe(29)
    const columns = raw.prepare('PRAGMA table_info(worker_terminal_resources)').all() as {
      name: string
    }[]
    expect(columns.map((column) => column.name)).toContain('ownership_state')
    expect(columns.map((column) => column.name)).toContain('release_state')
    expect(columns.map((column) => column.name)).not.toContain('lifecycle_state')
    expect(
      raw.prepare('SELECT ownership_state, release_state FROM worker_terminal_resources').get()
    ).toEqual({ ownership_state: 'owned', release_state: 'future_state' })
    raw.close()
  })

  it('classifies every existing v31 recovery with a successor as retry_with_successor', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-worker-recovery-v32-migration-'))
    const raw = new Database(join(tempDir, 'orchestration.db'))
    raw.exec(`
      CREATE TABLE worker_dispatches (dispatch_id TEXT PRIMARY KEY, worktree_id TEXT);
      ${workerContainmentRecoveryTablesSql()}
    `)
    raw
      .prepare(
        `INSERT INTO worker_lost_custody_recoveries (
           id, run_id, task_id, source_dispatch_id, source_resource_id, source_delivery_id,
           source_worktree_id, trusted_revision, successor_dispatch_id, successor_placement,
           successor_name, authorization, mutation_caller_fingerprint, mutation_request_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'recovery-v30',
        'run-v30',
        'task-v30',
        'source-v30',
        'resource-v30',
        'delivery-v30',
        'worktree-v30',
        '0123456789abcdef0123456789abcdef01234567',
        'successor-v30',
        'new-child',
        'successor-generation',
        'acknowledge_possible_duplicate_external_effects',
        'caller-v30',
        'request-v30'
      )

    migrateWorkerRecoveryOperationsV32(raw)

    expect(
      raw
        .prepare(
          'SELECT disposition, successor_dispatch_id FROM worker_lost_custody_recoveries WHERE id = ?'
        )
        .get('recovery-v30')
    ).toEqual({ disposition: 'retry_with_successor', successor_dispatch_id: 'successor-v30' })
    raw.close()
  })
})
