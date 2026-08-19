import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { federatedAgentTerminalWasCreated } from '../../orchestration/federated-worker-terminal-ownership'
import type { FederationEffect } from './orchestration-federation-effects'

export async function closeFederatedAgentTerminalWithoutAuthority(params: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  terminalHandle: string
  setupState: string
  effects: FederationEffect[]
}): Promise<void> {
  if (!federatedAgentTerminalWasCreated(params.effects, params.terminalHandle)) {
    return
  }
  const closed = await params.runtime.closeTerminal(params.terminalHandle).catch(() => null)
  if (!closed?.ptyKilled) {
    return
  }
  const agentEffect = params.effects.find(
    (effect) =>
      effect.kind === 'terminal' && effect.role === 'agent' && effect.id === params.terminalHandle
  )
  if (agentEffect) {
    agentEffect.action = 'closed_after_failed_start'
  }
  params.db.recordRemoteAttachmentTopology({
    dispatchId: params.dispatchId,
    worktreeId: params.worktreeId,
    terminalHandle: params.terminalHandle,
    setupState: params.setupState,
    effects: params.effects
  })
}
