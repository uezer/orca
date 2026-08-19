import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function recordRemoteAttachmentTopology(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    worktreeId: string
    terminalHandle: string
    setupState: string
    effects: unknown[]
  }
): void {
  const result = this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET worktree_id = ?, terminal_handle = ?, setup_state = ?, effects = ?,
           residual_resources = ?, updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = 'starting'`
    )
    .run(
      params.worktreeId,
      params.terminalHandle,
      params.setupState,
      JSON.stringify(params.effects),
      JSON.stringify(
        params.effects.filter(
          (effect) =>
            Boolean(effect) &&
            typeof effect === 'object' &&
            ((effect as { action?: string }).action?.startsWith('created') ||
              (effect as { action?: string }).action === 'reused_agent_terminal')
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
}

export type RemoteDispatchAttachmentTopologyMethods = {
  recordRemoteAttachmentTopology: typeof recordRemoteAttachmentTopology
}

export function attachRemoteDispatchAttachmentTopology(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { recordRemoteAttachmentTopology })
}
