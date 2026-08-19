import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteDispatchAttachmentRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { hashDispatchCapability } from '../dispatch-capability-hash'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { claimRemoteAttachmentLeaseForStart } from './remote-dispatch-attachment-lease'

export function prepareRemoteAttachmentAuthority(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
    worktreeId: string
    terminalHandle: string
    setupState: string
    effects: unknown[]
  }
): string {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
    if (!attachment || attachment.state !== 'starting') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${params.dispatchId} is not starting.`
      )
    }
    claimRemoteAttachmentLeaseForStart.call(this, params)
    const capability = `dcap_${randomBytes(32).toString('base64url')}`
    const result = this.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET stage = 'authority_attached', capability_hash = ?, pane_key = ?,
             process_incarnation = ?, worktree_id = ?, terminal_handle = ?, setup_state = ?,
             effects = ?, residual_resources = ?, updated_at = datetime('now')
         WHERE dispatch_id = ? AND state = 'starting'`
      )
      .run(
        hashDispatchCapability(capability),
        params.paneKey,
        params.processIncarnation,
        params.worktreeId,
        params.terminalHandle,
        params.setupState,
        JSON.stringify(params.effects),
        JSON.stringify(
          params.effects.filter((effect) =>
            Boolean(
              effect &&
              typeof effect === 'object' &&
              ((effect as { action?: string }).action?.startsWith('created') ||
                (effect as { action?: string }).action === 'reused_agent_terminal')
            )
          )
        ),
        params.dispatchId
      )
    if (result.changes !== 1) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Remote Dispatch ${params.dispatchId} is not starting.`
      )
    }
    this.db.exec('COMMIT')
    return capability
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function markRemoteAttachmentReady(
  this: OrchestrationDb,
  dispatchId: string,
  effects?: unknown[]
): RemoteDispatchAttachmentRow {
  const result = this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET state = 'ready', stage = 'input_accepted',
           effects = COALESCE(?, effects), updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = 'starting'`
    )
    .run(effects ? JSON.stringify(effects) : null, dispatchId)
  if (result.changes !== 1) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Remote Dispatch ${dispatchId} is not starting.`
    )
  }
  return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
}

export function failRemoteAttachment(
  this: OrchestrationDb,
  dispatchId: string,
  stage: string,
  reason: string,
  unknown: boolean
): RemoteDispatchAttachmentRow {
  const state = unknown ? 'start_unknown' : 'failed'
  const result = this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET state = ?, stage = ?, last_error = ?, capability_hash = NULL,
           updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = 'starting'`
    )
    .run(state, stage, reason, dispatchId)
  if (result.changes !== 1) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Remote Dispatch ${dispatchId} is not starting.`
    )
  }
  return this.getRemoteDispatchAttachment(dispatchId) as RemoteDispatchAttachmentRow
}

export function verifyRemoteAttachmentAuthority(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    capability: string | undefined
    paneKey: string | null
    processIncarnation: string | null
  }
): boolean {
  const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
  if (
    !attachment?.capability_hash ||
    !params.capability ||
    !attachment.pane_key ||
    !params.paneKey ||
    !isEquivalentPaneKey(attachment.pane_key, params.paneKey) ||
    !attachment.process_incarnation ||
    attachment.process_incarnation !== params.processIncarnation
  ) {
    return false
  }
  const expected = Buffer.from(attachment.capability_hash, 'hex')
  const observed = Buffer.from(hashDispatchCapability(params.capability), 'hex')
  return expected.length === observed.length && timingSafeEqual(expected, observed)
}

export function isRemoteAttachmentProcessCurrent(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    paneKey: string | null
    processIncarnation: string | null
  }
): boolean {
  const attachment = this.getRemoteDispatchAttachment(params.dispatchId)
  const identityMatches = Boolean(
    attachment?.pane_key &&
    params.paneKey &&
    isEquivalentPaneKey(attachment.pane_key, params.paneKey) &&
    attachment.process_incarnation &&
    attachment.process_incarnation === params.processIncarnation
  )
  if (!identityMatches || !attachment?.pane_key || !attachment.process_incarnation) {
    return false
  }
  const candidates = this.db
    .prepare(
      `SELECT pane_key FROM remote_dispatch_attachments
       WHERE dispatch_id != ? AND process_incarnation = ? AND release_state != 'released'`
    )
    .all(params.dispatchId, attachment.process_incarnation) as { pane_key: string | null }[]
  return !candidates.some(
    (candidate) =>
      candidate.pane_key && isEquivalentPaneKey(candidate.pane_key, attachment.pane_key as string)
  )
}

export function markRemoteAttachmentUserOwned(this: OrchestrationDb, paneKey: string): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const candidates = this.db
      .prepare(
        `SELECT dispatch_id, pane_key FROM remote_dispatch_attachments
         WHERE pane_key IS NOT NULL AND state != 'stopping'
           AND release_state IN ('not_requested', 'retained', 'requested', 'releasing')
           AND (release_state != 'releasing' OR release_error IS NULL)`
      )
      .all() as { dispatch_id: string; pane_key: string }[]
    const update = this.db.prepare(
      `UPDATE remote_dispatch_attachments
       SET release_state = 'retained', release_error = 'user_takeover',
           archive_kind = NULL, archive_content = NULL, archive_source = NULL,
           archive_status = NULL, updated_at = datetime('now')
        WHERE dispatch_id = ? AND state != 'stopping'
          AND release_state IN ('not_requested', 'retained', 'requested', 'releasing')
          AND (release_state != 'releasing' OR release_error IS NULL)`
    )
    let changed = 0
    for (const candidate of candidates) {
      if (isEquivalentPaneKey(candidate.pane_key, paneKey)) {
        changed += Number(update.run(candidate.dispatch_id).changes)
      }
    }
    this.db.exec('COMMIT')
    return changed
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type RemoteDispatchAttachmentAuthorityMethods = {
  prepareRemoteAttachmentAuthority: typeof prepareRemoteAttachmentAuthority
  markRemoteAttachmentReady: typeof markRemoteAttachmentReady
  failRemoteAttachment: typeof failRemoteAttachment
  verifyRemoteAttachmentAuthority: typeof verifyRemoteAttachmentAuthority
  isRemoteAttachmentProcessCurrent: typeof isRemoteAttachmentProcessCurrent
  markRemoteAttachmentUserOwned: typeof markRemoteAttachmentUserOwned
}

export function attachRemoteDispatchAttachmentAuthority(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    prepareRemoteAttachmentAuthority,
    markRemoteAttachmentReady,
    failRemoteAttachment,
    verifyRemoteAttachmentAuthority,
    isRemoteAttachmentProcessCurrent,
    markRemoteAttachmentUserOwned
  })
}
