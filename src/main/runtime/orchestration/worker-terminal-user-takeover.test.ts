import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const PANE_KEY = 'tab_current:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INCARNATION = 'runtime_test:term_worker:1'

describe('worker terminal user takeover authority', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    const insert = db.db.prepare(
      `INSERT INTO worker_terminal_resources (
         id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
         process_incarnation, host_scope, ownership_state, release_state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'owned', 'not_requested')`
    )
    insert.run(
      'wtr_stale_exact',
      'ctx_stale_exact',
      'ctx_stale_exact',
      'term_stale_exact',
      PANE_KEY,
      'runtime_test:term_worker:stale',
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    insert.run(
      'wtr_current_reminted',
      'ctx_current_reminted',
      'ctx_current_reminted',
      'term_current_reminted',
      `tab_reminted:${PANE_KEY.split(':')[1]}`,
      INCARNATION,
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
  })

  afterEach(() => db.close())

  it('marks a reminted current incarnation hidden by an exact stale pane row', () => {
    expect(db.markWorkerTerminalUserOwned(PANE_KEY, INCARNATION)).toBe(1)
    expect(db.getWorkerTerminalResource('wtr_stale_exact')).toMatchObject({
      ownership_state: 'owned',
      release_state: 'not_requested'
    })
    expect(db.getWorkerTerminalResource('wtr_current_reminted')).toMatchObject({
      ownership_state: 'user_owned',
      release_state: 'retained'
    })
  })
})
