import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('federation acknowledgment migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('adds a zeroed durable acknowledgment watermark to v26 dispatches', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-federation-ack-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec('ALTER TABLE federated_dispatches DROP COLUMN to_home_acknowledged_sequence')
    oldDb.pragma('user_version = 26')
    expect(resolveOrchestrationMigrationStartVersion(oldDb, 26, SCHEMA_VERSION)).toBe(26)
    oldDb
      .prepare(
        `INSERT INTO federated_dispatches (
           dispatch_id, environment_id, environment_name, peer_fingerprint,
           protocol_version, to_home_imported_sequence
         ) VALUES ('ctx_migrated', 'env', 'worker', 'peer', 3, 2)`
      )
      .run()
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getFederatedDispatch('ctx_migrated')).toMatchObject({
      to_home_imported_sequence: 2,
      to_home_acknowledged_sequence: 0
    })
  })

  it('adds federated release and archive state to v28 attachments', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-federation-release-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP INDEX IF EXISTS idx_remote_dispatch_attachments_unreleased_process')
    oldDb.exec('ALTER TABLE remote_dispatch_attachments DROP COLUMN archive_content')
    oldDb.exec('ALTER TABLE remote_dispatch_attachments DROP COLUMN release_state')
    oldDb.pragma('user_version = 28')
    expect(resolveOrchestrationMigrationStartVersion(oldDb, 28, SCHEMA_VERSION)).toBe(28)
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    const columns = sqlite.pragma('table_info(remote_dispatch_attachments)') as { name: string }[]
    const indexes = sqlite.pragma('index_list(remote_dispatch_attachments)') as { name: string }[]

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'release_state',
        'archive_content',
        'release_request_id',
        'release_completed_at'
      ])
    )
    expect(indexes.map((index) => index.name)).toContain(
      'idx_remote_dispatch_attachments_unreleased_process'
    )
  })

  it('repairs a v30 database missing the remote release identity index', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-federation-release-index-repair-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec('DROP INDEX idx_remote_dispatch_attachments_unreleased_process')
    expect(resolveOrchestrationMigrationStartVersion(oldDb, SCHEMA_VERSION, SCHEMA_VERSION)).toBe(6)
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db
    const indexes = sqlite.pragma('index_list(remote_dispatch_attachments)') as { name: string }[]

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(indexes.map((index) => index.name)).toContain(
      'idx_remote_dispatch_attachments_unreleased_process'
    )
  })
})
