import type { OrchestrationDb } from '../../orchestration/db'

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
  const terminalCreated = (remote.effects ?? []).some(
    (effect) =>
      Boolean(effect) &&
      typeof effect === 'object' &&
      (effect as { kind?: string; action?: string }).kind === 'terminal' &&
      ['created', 'reused_agent_terminal'].includes((effect as { action?: string }).action ?? '')
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
