import type Database from '../../../sqlite/sync-database'

export function claimFederatedRelease(
  db: Database.Database,
  dispatchId: string,
  requestId: string
): 'claimed' | 'busy' | 'released' {
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = db
      .prepare(
        'SELECT release_state, release_request_id FROM remote_dispatch_attachments WHERE dispatch_id = ?'
      )
      .get(dispatchId) as { release_state: string; release_request_id: string | null } | undefined
    if (!current) {
      throw new Error(`Remote Dispatch ${dispatchId} was not found.`)
    }
    if (current.release_state === 'released') {
      db.exec('COMMIT')
      return 'released'
    }
    if (
      ['requested', 'releasing'].includes(current.release_state) &&
      current.release_request_id !== requestId
    ) {
      db.exec('COMMIT')
      return 'busy'
    }
    db.prepare(
      `UPDATE remote_dispatch_attachments
       SET release_state = 'requested', release_request_id = ?,
           release_requested_at = COALESCE(release_requested_at, datetime('now')),
           release_error = NULL, updated_at = datetime('now')
       WHERE dispatch_id = ?
         AND release_state IN ('not_requested', 'retained', 'requested', 'releasing', 'unknown')`
    ).run(requestId, dispatchId)
    db.exec('COMMIT')
    return 'claimed'
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function commitFederatedReleaseClose(
  db: Database.Database,
  dispatchId: string,
  requestId: string
): boolean {
  return (
    db
      .prepare(
        `UPDATE remote_dispatch_attachments SET release_error = 'close_committed',
                updated_at = datetime('now')
         WHERE dispatch_id = ? AND release_state = 'releasing'
           AND release_request_id = ? AND release_error IS NULL`
      )
      .run(dispatchId, requestId).changes === 1
  )
}

export function settleFederatedRelease(
  db: Database.Database,
  dispatchId: string,
  requestId: string
): boolean {
  return (
    db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET release_state = 'released', release_completed_at = datetime('now'),
             release_error = NULL, updated_at = datetime('now')
         WHERE dispatch_id = ? AND release_state IN ('requested', 'releasing')
           AND release_request_id = ?`
      )
      .run(dispatchId, requestId).changes === 1
  )
}

export function transitionFederatedReleaseFailure(
  db: Database.Database,
  params: {
    dispatchId: string
    requestId: string
    fromState: 'requested' | 'releasing'
    fromError: string | null
    toState: 'retained' | 'unknown'
    error: string
  }
): boolean {
  const expectedError = params.fromError === null ? 'release_error IS NULL' : 'release_error = ?'
  const values = [params.toState, params.error, params.dispatchId, params.requestId]
  if (params.fromError !== null) {
    values.push(params.fromError)
  }
  return (
    db
      .prepare(
        `UPDATE remote_dispatch_attachments SET release_state = ?, release_error = ?,
                updated_at = datetime('now')
         WHERE dispatch_id = ? AND release_request_id = ?
           AND release_state = '${params.fromState}' AND ${expectedError}`
      )
      .run(...values).changes === 1
  )
}
