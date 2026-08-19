import { z } from 'zod'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import type Database from '../../../sqlite/sync-database'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RemoteDispatchAttachmentRow } from '../../orchestration/types'
import { captureWorkerOutputArchive } from '../../orchestration/worker-output-archive'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { orchestrationTimestampToMs } from './orchestration-worker-output'

const Params = z.object({ dispatchId: requiredString('Missing Dispatch ID') })
const activeReleaseRequests = new Set<string>()

export const ORCHESTRATION_FEDERATION_RELEASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationRelease',
    params: Params,
    handler: async (params, { runtime, authenticatedCallerFingerprint, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const attachment = requireAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      if (attachment.release_state === 'released') {
        return { state: 'already_released', processAction: 'none', archive: archiveOf(attachment) }
      }
      if (isUserTakeover(attachment)) {
        return userTakeoverReceipt(attachment)
      }
      if (!['succeeded', 'failed'].includes(attachment.state)) {
        return {
          state: 'retained',
          processAction: 'none',
          archive: archiveOf(attachment),
          lastError: `Remote Dispatch ${params.dispatchId} is ${attachment.state}; only settled workers can release.`
        }
      }
      if (!orchestrationMutation) {
        throw new Error('Federated release requires a durable request identity.')
      }
      const activeKey = `${runtime.getRuntimeId()}:${params.dispatchId}:${orchestrationMutation.requestId}`
      if (activeReleaseRequests.has(activeKey)) {
        return {
          state: 'release_pending',
          processAction: 'none',
          archive: archiveOf(db.getRemoteDispatchAttachment(params.dispatchId))
        }
      }
      activeReleaseRequests.add(activeKey)
      try {
        const claim = claimRelease(db.db, params.dispatchId, orchestrationMutation.requestId)
        if (claim === 'released') {
          return {
            state: 'already_released',
            processAction: 'none',
            archive: archiveOf(db.getRemoteDispatchAttachment(params.dispatchId))
          }
        }
        if (claim === 'busy') {
          return {
            state: 'release_pending',
            processAction: 'none',
            archive: archiveOf(db.getRemoteDispatchAttachment(params.dispatchId))
          }
        }
        const observation = await inspectAttachment(runtime, params.dispatchId)
        if (!observation.exact || !observation.terminal) {
          const reason = `The recorded worker process is ${observation.status}; no terminal was closed.`
          updateRelease(db.db, params.dispatchId, 'unknown', reason)
          return {
            state: 'release_unknown',
            processAction: 'none',
            archive: archiveOf(db.getRemoteDispatchAttachment(params.dispatchId)),
            lastError: reason
          }
        }
        let archive: ReturnType<typeof createArchive>
        try {
          const captured = await captureWorkerOutputArchive({
            runtime,
            dispatchId: params.dispatchId,
            terminalHandle: observation.terminal.handle,
            attachedAtMs: orchestrationTimestampToMs(attachment.created_at)
          })
          archive = createArchive(captured)
          const stored = db.db
            .prepare(
              `UPDATE remote_dispatch_attachments
             SET release_state = 'releasing', archive_kind = ?, archive_content = ?, archive_source = ?,
                 archive_status = ?, release_requested_at = COALESCE(release_requested_at, datetime('now')),
                 release_error = NULL, updated_at = datetime('now')
             WHERE dispatch_id = ? AND release_state = 'requested' AND release_request_id = ?`
            )
            .run(
              archive.kind,
              archive.content,
              archive.source,
              archive.status,
              params.dispatchId,
              orchestrationMutation.requestId
            )
          if (stored.changes !== 1) {
            const current = db.getRemoteDispatchAttachment(params.dispatchId)
            if (isUserTakeover(current)) {
              return userTakeoverReceipt(current)
            }
            return {
              state: 'release_pending',
              processAction: 'none',
              archive: archiveOf(current)
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          updateRelease(db.db, params.dispatchId, 'retained', reason)
          return {
            state: 'retained',
            processAction: 'none',
            archive: archiveOf(db.getRemoteDispatchAttachment(params.dispatchId)),
            lastError: reason
          }
        }
        const rechecked = await inspectAttachment(runtime, params.dispatchId)
        if (
          !rechecked.exact ||
          !rechecked.terminal ||
          rechecked.terminal.handle !== observation.terminal.handle
        ) {
          const reason = `The recorded worker process changed during output capture; no terminal was closed.`
          updateRelease(db.db, params.dispatchId, 'retained', reason)
          return { state: 'retained', processAction: 'none', archive, lastError: reason }
        }
        try {
          const close = await runtime.closeTerminal(rechecked.terminal.handle)
          if (!close.ptyKilled) {
            const reason = describeUnconfirmedAgentStop(close)
            updateRelease(db.db, params.dispatchId, 'unknown', reason)
            return {
              state: 'release_unknown',
              processAction: 'closed_agent_terminal',
              archive,
              lastError: reason
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          updateRelease(db.db, params.dispatchId, 'unknown', reason)
          return { state: 'release_unknown', processAction: 'none', archive, lastError: reason }
        }
        db.db
          .prepare(
            `UPDATE remote_dispatch_attachments
           SET release_state = 'released', release_completed_at = datetime('now'), release_error = NULL,
               updated_at = datetime('now') WHERE dispatch_id = ?`
          )
          .run(params.dispatchId)
        return {
          state: 'released',
          processAction:
            rechecked.status === 'exited' ? 'closed_exited_terminal' : 'closed_agent_terminal',
          archive
        }
      } finally {
        activeReleaseRequests.delete(activeKey)
      }
    }
  })
]

function requireAttachment(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  callerFingerprint: string | undefined
): RemoteDispatchAttachmentRow {
  const attachment = runtime.getOrchestrationDb().getRemoteDispatchAttachment(dispatchId)
  if (!attachment || attachment.home_peer_fingerprint !== callerFingerprint) {
    throw new Error(`Remote Dispatch ${dispatchId} was not found for this Run home.`)
  }
  return attachment
}

async function inspectAttachment(runtime: OrcaRuntimeService, dispatchId: string) {
  const db = runtime.getOrchestrationDb()
  const attachment = db.getRemoteDispatchAttachment(dispatchId)
  if (!attachment?.terminal_handle) {
    return { terminal: null, exact: false, status: 'unattached' as const }
  }
  const terminal = await runtime.showTerminal(attachment.terminal_handle).catch(() => null)
  if (!terminal) {
    return { terminal: null, exact: false, status: 'missing' as const }
  }
  const exact = db.isRemoteAttachmentProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(attachment.terminal_handle),
    processIncarnation: runtime.getTerminalProcessIncarnation(attachment.terminal_handle)
  })
  if (!exact) {
    return { terminal, exact, status: 'identity_changed' as const }
  }
  const verdict = runtime.getTerminalLivenessVerdict?.(attachment.terminal_handle) ?? null
  if (verdict?.status === 'unverifiable') {
    return { terminal, exact, status: 'unverifiable' as const }
  }
  return {
    terminal,
    exact,
    status:
      verdict?.status !== 'live' && terminal.connected === false
        ? ('exited' as const)
        : ('live' as const)
  }
}

function updateRelease(
  db: Database.Database,
  dispatchId: string,
  state: string,
  error: string
): void {
  db.prepare(
    `UPDATE remote_dispatch_attachments SET release_state = ?, release_error = ?, updated_at = datetime('now') WHERE dispatch_id = ?`
  ).run(state, error, dispatchId)
}

function claimRelease(
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
       WHERE dispatch_id = ? AND release_state IN ('not_requested', 'retained', 'requested', 'unknown')`
    ).run(requestId, dispatchId)
    db.exec('COMMIT')
    return 'claimed'
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function createArchive(captured: Awaited<ReturnType<typeof captureWorkerOutputArchive>>) {
  return {
    kind: captured.kind,
    content: JSON.stringify(captured.content),
    source: captured.kind === 'transcript_pin' ? ('transcript' as const) : ('terminal' as const),
    status: captured.status
  }
}

function archiveOf(attachment: RemoteDispatchAttachmentRow | undefined) {
  if (!attachment?.archive_content || !attachment.archive_kind) {
    return null
  }
  return {
    kind: attachment.archive_kind,
    content: attachment.archive_content,
    source: attachment.archive_source ?? 'terminal',
    status: attachment.archive_status ?? 'captured'
  }
}

function isUserTakeover(attachment: RemoteDispatchAttachmentRow | undefined): boolean {
  return attachment?.release_state === 'retained' && attachment.release_error === 'user_takeover'
}

function userTakeoverReceipt(attachment: RemoteDispatchAttachmentRow | undefined) {
  return {
    state: 'retained' as const,
    reason: 'user_takeover' as const,
    processAction: 'none' as const,
    archive: archiveOf(attachment)
  }
}
