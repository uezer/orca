import type { OrchestrationDb } from '../../orchestration/db'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  archiveSummary,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-completion'
import { resolvePinnedFederatedServer } from './orchestration-worker-observation'

type FederatedReleaseReceipt = {
  state: 'released' | 'already_released' | 'retained' | 'release_pending' | 'release_unknown'
  processAction: 'closed_agent_terminal' | 'closed_exited_terminal' | 'none'
  archive: {
    kind: 'terminal_tail' | 'transcript_pin'
    content: string
    source: 'terminal' | 'transcript'
    status: 'captured' | 'empty' | 'unavailable'
  } | null
  reason?: 'identity_unproven' | 'user_takeover'
  lastError?: string
}

export async function completeFederatedWorkerTerminalRelease(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
}): Promise<WorkerReleaseReceipt> {
  const federated = args.db.getFederatedDispatch(args.dispatchId)
  if (!federated) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Federated Dispatch ${args.dispatchId} was not found.`
    )
  }
  const server = resolvePinnedFederatedServer(args.runtime, federated)
  let status: RuntimeStatus
  try {
    status = (await args.runtime.callOrchestrationWorkerServer(
      server.environmentId,
      'status.get',
      undefined,
      10_000
    )) as RuntimeStatus
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      dispatchId: args.dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: archiveSummary(args.db.getWorkerTerminalResource(args.resource.id) ?? null),
      lastError: reason
    }
  }
  if (!status.capabilities?.includes(ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY)) {
    const retained = args.db.revertWorkerTerminalReleaseToRetained(
      args.resource.id,
      'federation_unsupported'
    )
    return {
      dispatchId: args.dispatchId,
      state: 'retained',
      reason: 'federation_unsupported',
      processAction: 'none',
      archive: archiveSummary(retained),
      recovery: 'The connected worker server does not support federated terminal release.'
    }
  }
  const committed = args.db.commitFederatedWorkerTerminalRelease(args.resource.id)
  if (committed.release_state !== 'releasing') {
    return {
      dispatchId: args.dispatchId,
      state: committed.release_state === 'released' ? 'already_released' : 'retained',
      reason: 'user_requested',
      processAction: 'none',
      archive: archiveSummary(committed)
    }
  }
  let remote: FederatedReleaseReceipt
  try {
    remote = (await args.runtime.callOrchestrationWorkerServer(
      server.environmentId,
      'orchestration.federationRelease',
      { dispatchId: args.dispatchId },
      30_000,
      {
        orchestrationRequestId: `federation_release:${args.resource.id}:${args.resource.release_requested_at}`
      }
    )) as FederatedReleaseReceipt
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (federatedReleaseUnsupported(error)) {
      const retained = args.db.revertWorkerTerminalReleaseToRetained(
        args.resource.id,
        'federation_unsupported'
      )
      return {
        dispatchId: args.dispatchId,
        state: 'retained',
        reason: 'federation_unsupported',
        processAction: 'none',
        archive: archiveSummary(retained),
        recovery: 'The connected worker server does not support federated terminal release.'
      }
    }
    const unknown = args.db.markWorkerTerminalReleaseUnknown(args.resource.id, reason)
    return {
      dispatchId: args.dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: archiveSummary(unknown),
      lastError: reason
    }
  }

  if (remote.archive) {
    args.db.commitWorkerTerminalArchiveForRelease({
      dispatchId: args.dispatchId,
      resourceId: args.resource.id,
      kind: remote.archive.kind,
      content: remote.archive.content,
      archiveSource: remote.archive.source,
      archiveStatus: remote.archive.status === 'unavailable' ? 'empty' : remote.archive.status
    })
  }
  if (remote.state === 'released' || remote.state === 'already_released') {
    const settled = args.db.settleWorkerTerminalRelease(args.resource.id)
    args.runtime.notifyMessageArrived(`dispatch:${args.dispatchId}`, 'status')
    return {
      dispatchId: args.dispatchId,
      state: remote.state,
      processAction: remote.processAction,
      archive: archiveSummary(settled)
    }
  }
  if (remote.state === 'retained') {
    const reason = remote.reason === 'user_takeover' ? 'user_takeover' : 'identity_unproven'
    const retained = args.db.revertWorkerTerminalReleaseToRetained(args.resource.id, reason)
    return {
      dispatchId: args.dispatchId,
      state: 'retained',
      reason,
      processAction: 'none',
      archive: archiveSummary(retained),
      ...(remote.lastError ? { lastError: remote.lastError } : {})
    }
  }
  if (remote.state === 'release_pending') {
    // Keep ordinary remote lease contention retryable by reconciliation.
    return {
      dispatchId: args.dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: archiveSummary(args.db.getWorkerTerminalResource(args.resource.id) ?? null),
      ...(remote.lastError ? { lastError: remote.lastError } : {})
    }
  }
  const unknown = args.db.markWorkerTerminalReleaseUnknown(
    args.resource.id,
    remote.lastError ?? 'The worker server did not confirm terminal release.'
  )
  return {
    dispatchId: args.dispatchId,
    state: remote.state,
    processAction: remote.processAction,
    archive: archiveSummary(unknown),
    ...(remote.lastError ? { lastError: remote.lastError } : {})
  }
}

function federatedReleaseUnsupported(error: unknown): boolean {
  return (
    (error instanceof OrchestrationError &&
      ['method_not_found', 'capability_unsupported'].includes(error.code)) ||
    /method_not_found|capability/i.test(error instanceof Error ? error.message : String(error))
  )
}
