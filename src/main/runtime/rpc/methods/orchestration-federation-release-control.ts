import { z } from 'zod'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'
import { captureWorkerOutputArchive } from '../../orchestration/worker-output-archive'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import { orchestrationTimestampToMs } from './orchestration-worker-output'
import {
  concurrentFederatedReleaseReceipt,
  createFederatedReleaseArchive,
  federatedReleaseArchive,
  federatedUserTakeoverReceipt,
  inspectFederatedReleaseAttachment,
  isFederatedReleaseUserTakeover,
  requireFederatedReleaseAttachment
} from './orchestration-federation-release-evidence'
import {
  claimFederatedRelease,
  commitFederatedReleaseClose,
  settleFederatedRelease,
  transitionFederatedReleaseFailure
} from './orchestration-federation-release-state'

const Params = z.object({ dispatchId: requiredString('Missing Dispatch ID') })
const activeReleaseRequests = new Set<string>()
const LOCAL_TERMINAL_HOST_SCOPE = JSON.stringify({ kind: 'local', hostId: 'local' })

export const ORCHESTRATION_FEDERATION_RELEASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationRelease',
    params: Params,
    handler: async (params, { runtime, authenticatedCallerFingerprint, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const attachment = requireFederatedReleaseAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      if (attachment.release_state === 'released') {
        return {
          state: 'already_released',
          processAction: 'none',
          archive: federatedReleaseArchive(attachment)
        }
      }
      if (isFederatedReleaseUserTakeover(attachment)) {
        return federatedUserTakeoverReceipt(attachment)
      }
      if (!['succeeded', 'failed'].includes(attachment.state)) {
        return {
          state: 'retained',
          processAction: 'none',
          archive: federatedReleaseArchive(attachment),
          lastError: `Remote Dispatch ${params.dispatchId} is ${attachment.state}; only settled workers can release.`
        }
      }
      if (!orchestrationMutation) {
        throw new Error('Federated release requires a durable request identity.')
      }
      const resumingArchivedRelease =
        attachment.release_state === 'releasing' &&
        attachment.release_request_id === orchestrationMutation.requestId &&
        Boolean(federatedReleaseArchive(attachment))
      const activeKey = `${runtime.getRuntimeId()}:${params.dispatchId}:${orchestrationMutation.requestId}`
      if (activeReleaseRequests.has(activeKey)) {
        return {
          state: 'release_pending',
          processAction: 'none',
          archive: federatedReleaseArchive(db.getRemoteDispatchAttachment(params.dispatchId))
        }
      }
      activeReleaseRequests.add(activeKey)
      try {
        const claim = claimFederatedRelease(
          db.db,
          params.dispatchId,
          orchestrationMutation.requestId
        )
        if (claim === 'released') {
          return {
            state: 'already_released',
            processAction: 'none',
            archive: federatedReleaseArchive(db.getRemoteDispatchAttachment(params.dispatchId))
          }
        }
        if (claim === 'busy') {
          return {
            state: 'release_pending',
            processAction: 'none',
            archive: federatedReleaseArchive(db.getRemoteDispatchAttachment(params.dispatchId))
          }
        }
        const observation = await inspectFederatedReleaseAttachment(runtime, params.dispatchId)
        if (
          resumingArchivedRelease &&
          observation.status === 'missing' &&
          attachment.process_incarnation &&
          (await runtime.inspectTerminalProcessIncarnationLiveness(
            attachment.process_incarnation,
            LOCAL_TERMINAL_HOST_SCOPE
          )) === 'exited'
        ) {
          const settled = settleFederatedRelease(
            db.db,
            params.dispatchId,
            orchestrationMutation.requestId
          )
          const current = db.getRemoteDispatchAttachment(params.dispatchId)
          if (settled) {
            return {
              state: 'released',
              processAction: 'none',
              archive: federatedReleaseArchive(current)
            }
          }
          if (isFederatedReleaseUserTakeover(current)) {
            return federatedUserTakeoverReceipt(current)
          }
          return {
            state: 'release_pending',
            processAction: 'none',
            archive: federatedReleaseArchive(current)
          }
        }
        if (!observation.exact || !observation.terminal) {
          const reason = `The recorded worker process is ${observation.status}; no terminal was closed.`
          if (
            !transitionFederatedReleaseFailure(db.db, {
              dispatchId: params.dispatchId,
              requestId: orchestrationMutation.requestId,
              fromState: 'requested',
              fromError: null,
              toState: 'unknown',
              error: reason
            })
          ) {
            return concurrentFederatedReleaseReceipt(runtime, params.dispatchId)
          }
          return {
            state: 'release_unknown',
            processAction: 'none',
            archive: federatedReleaseArchive(db.getRemoteDispatchAttachment(params.dispatchId)),
            lastError: reason
          }
        }
        let archive: ReturnType<typeof createFederatedReleaseArchive>
        try {
          const captured = await captureWorkerOutputArchive({
            runtime,
            dispatchId: params.dispatchId,
            terminalHandle: observation.terminal.handle,
            attachedAtMs: orchestrationTimestampToMs(attachment.created_at)
          })
          archive = createFederatedReleaseArchive(captured)
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
            if (isFederatedReleaseUserTakeover(current)) {
              return federatedUserTakeoverReceipt(current)
            }
            return {
              state: 'release_pending',
              processAction: 'none',
              archive: federatedReleaseArchive(current)
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (
            !transitionFederatedReleaseFailure(db.db, {
              dispatchId: params.dispatchId,
              requestId: orchestrationMutation.requestId,
              fromState: 'requested',
              fromError: null,
              toState: 'retained',
              error: reason
            })
          ) {
            return concurrentFederatedReleaseReceipt(runtime, params.dispatchId)
          }
          return {
            state: 'retained',
            processAction: 'none',
            archive: federatedReleaseArchive(db.getRemoteDispatchAttachment(params.dispatchId)),
            lastError: reason
          }
        }
        const rechecked = await inspectFederatedReleaseAttachment(runtime, params.dispatchId)
        if (
          !rechecked.exact ||
          !rechecked.terminal ||
          rechecked.terminal.handle !== observation.terminal.handle
        ) {
          const reason = `The recorded worker process changed during output capture; no terminal was closed.`
          if (
            !transitionFederatedReleaseFailure(db.db, {
              dispatchId: params.dispatchId,
              requestId: orchestrationMutation.requestId,
              fromState: 'releasing',
              fromError: null,
              toState: 'retained',
              error: reason
            })
          ) {
            return concurrentFederatedReleaseReceipt(runtime, params.dispatchId)
          }
          return { state: 'retained', processAction: 'none', archive, lastError: reason }
        }
        if (
          !commitFederatedReleaseClose(db.db, params.dispatchId, orchestrationMutation.requestId)
        ) {
          const current = db.getRemoteDispatchAttachment(params.dispatchId)
          if (isFederatedReleaseUserTakeover(current)) {
            return federatedUserTakeoverReceipt(current)
          }
          return {
            state: 'release_pending',
            processAction: 'none',
            archive: federatedReleaseArchive(current)
          }
        }
        try {
          const close = await runtime.closeTerminal(rechecked.terminal.handle)
          if (!close.ptyKilled) {
            const reason = describeUnconfirmedAgentStop(close)
            if (
              !transitionFederatedReleaseFailure(db.db, {
                dispatchId: params.dispatchId,
                requestId: orchestrationMutation.requestId,
                fromState: 'releasing',
                fromError: 'close_committed',
                toState: 'unknown',
                error: reason
              })
            ) {
              return concurrentFederatedReleaseReceipt(runtime, params.dispatchId)
            }
            return {
              state: 'release_unknown',
              processAction: 'closed_agent_terminal',
              archive,
              lastError: reason
            }
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (
            !transitionFederatedReleaseFailure(db.db, {
              dispatchId: params.dispatchId,
              requestId: orchestrationMutation.requestId,
              fromState: 'releasing',
              fromError: 'close_committed',
              toState: 'unknown',
              error: reason
            })
          ) {
            return concurrentFederatedReleaseReceipt(runtime, params.dispatchId)
          }
          return { state: 'release_unknown', processAction: 'none', archive, lastError: reason }
        }
        if (!settleFederatedRelease(db.db, params.dispatchId, orchestrationMutation.requestId)) {
          return {
            state: 'release_pending',
            processAction: 'closed_agent_terminal',
            archive: federatedReleaseArchive(db.getRemoteDispatchAttachment(params.dispatchId))
          }
        }
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
