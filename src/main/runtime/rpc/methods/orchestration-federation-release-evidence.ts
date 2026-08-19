import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RemoteDispatchAttachmentRow } from '../../orchestration/types'
import type { captureWorkerOutputArchive } from '../../orchestration/worker-output-archive'

export function requireFederatedReleaseAttachment(
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

export async function inspectFederatedReleaseAttachment(
  runtime: OrcaRuntimeService,
  dispatchId: string
) {
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

export function createFederatedReleaseArchive(
  captured: Awaited<ReturnType<typeof captureWorkerOutputArchive>>
) {
  return {
    kind: captured.kind,
    content: JSON.stringify(captured.content),
    source: captured.kind === 'transcript_pin' ? ('transcript' as const) : ('terminal' as const),
    status: captured.status
  }
}

export function federatedReleaseArchive(attachment: RemoteDispatchAttachmentRow | undefined) {
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

export function isFederatedReleaseUserTakeover(
  attachment: RemoteDispatchAttachmentRow | undefined
): boolean {
  return attachment?.release_state === 'retained' && attachment.release_error === 'user_takeover'
}

export function federatedUserTakeoverReceipt(attachment: RemoteDispatchAttachmentRow | undefined) {
  return {
    state: 'retained' as const,
    reason: 'user_takeover' as const,
    processAction: 'none' as const,
    archive: federatedReleaseArchive(attachment)
  }
}

export function concurrentFederatedReleaseReceipt(runtime: OrcaRuntimeService, dispatchId: string) {
  const current = runtime.getOrchestrationDb().getRemoteDispatchAttachment(dispatchId)
  return isFederatedReleaseUserTakeover(current)
    ? federatedUserTakeoverReceipt(current)
    : {
        state: 'release_pending' as const,
        processAction: 'none' as const,
        archive: federatedReleaseArchive(current)
      }
}
