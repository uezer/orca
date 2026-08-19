import type { OrchestrationDb } from '../../orchestration/db'
import { federatedAgentTerminalWasCreated } from '../../orchestration/federated-worker-terminal-ownership'

export function recordFederatedWorkerTerminalResource(args: {
  db: OrchestrationDb
  dispatchId: string
  hostScope: string
  remote: {
    worktreeId?: string
    terminalHandle?: string
    paneKey?: string
    processIncarnation?: string
    effects?: unknown[]
  }
}): void {
  const { remote } = args
  if (
    !remote.worktreeId ||
    !remote.terminalHandle ||
    !remote.paneKey ||
    !remote.processIncarnation
  ) {
    return
  }
  const transferable = args.db.findTransferableWorkerTerminalResource({
    terminalHandle: remote.terminalHandle,
    paneKey: remote.paneKey,
    processIncarnation: remote.processIncarnation,
    hostScope: args.hostScope
  })
  if (transferable) {
    args.db.transferWorkerTerminalResourceStatement({
      resourceId: transferable.id,
      toDispatchId: args.dispatchId,
      terminalHandle: remote.terminalHandle,
      paneKey: remote.paneKey,
      processIncarnation: remote.processIncarnation,
      hostScope: args.hostScope
    })
    return
  }
  const terminalCreated = federatedAgentTerminalWasCreated(
    remote.effects ?? [],
    remote.terminalHandle
  )
  args.db.createWorkerTerminalResourceStatement({
    dispatchId: args.dispatchId,
    worktreeId: remote.worktreeId,
    terminalHandle: remote.terminalHandle,
    paneKey: remote.paneKey,
    processIncarnation: remote.processIncarnation,
    hostScope: args.hostScope,
    ownership: terminalCreated ? 'owned' : 'external'
  })
}
