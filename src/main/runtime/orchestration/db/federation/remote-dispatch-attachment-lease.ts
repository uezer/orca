import type { RemoteDispatchAttachmentRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

export function claimRemoteAttachmentLeaseForStart(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    paneKey: string
    processIncarnation: string
    terminalHandle: string
    effects: unknown[]
  }
): void {
  const candidates = this.db
    .prepare(
      `SELECT dispatch_id, pane_key, state, effects, release_state, release_error
       FROM remote_dispatch_attachments
       WHERE dispatch_id != ? AND process_incarnation = ? AND release_state != 'released'`
    )
    .all(params.dispatchId, params.processIncarnation) as Pick<
    RemoteDispatchAttachmentRow,
    'dispatch_id' | 'pane_key' | 'state' | 'effects' | 'release_state' | 'release_error'
  >[]
  const exact = candidates.filter(
    (candidate) => candidate.pane_key && isEquivalentPaneKey(candidate.pane_key, params.paneKey)
  )
  if (
    exact.some((candidate) =>
      ['requested', 'releasing', 'unknown'].includes(candidate.release_state ?? '')
    )
  ) {
    throw new OrchestrationError(
      'terminal_release_in_progress',
      `Terminal ${params.terminalHandle} has a release in progress.`
    )
  }
  if (exact.length === 0) {
    return
  }
  const explicitReuse = params.effects.some(
    (effect) =>
      Boolean(effect) &&
      typeof effect === 'object' &&
      (effect as { kind?: string }).kind === 'terminal' &&
      (effect as { role?: string }).role === 'agent' &&
      ['reused', 'reused_agent_terminal'].includes((effect as { action?: string }).action ?? '') &&
      (effect as { id?: string }).id === params.terminalHandle
  )
  const transferable = exact.every(
    (candidate) =>
      explicitReuse &&
      ['succeeded', 'failed', 'stopped', 'abandoned'].includes(candidate.state) &&
      ['not_requested', 'retained'].includes(candidate.release_state ?? '') &&
      (candidate.release_error === 'user_takeover' ||
        !remoteAttachmentOwnsAgentTerminal(candidate.effects, params.terminalHandle))
  )
  if (!transferable) {
    throw new OrchestrationError(
      'terminal_owned',
      `Terminal ${params.terminalHandle} is owned by another remote Dispatch.`
    )
  }
  const release = this.db.prepare(
    `UPDATE remote_dispatch_attachments
     SET release_state = 'released', capability_hash = NULL,
         release_completed_at = COALESCE(release_completed_at, datetime('now')),
         updated_at = datetime('now')
     WHERE dispatch_id = ? AND state IN ('succeeded', 'failed', 'stopped', 'abandoned')
       AND release_state IN ('not_requested', 'retained')`
  )
  for (const candidate of exact) {
    if (release.run(candidate.dispatch_id).changes !== 1) {
      throw new OrchestrationError(
        'terminal_owned',
        `Terminal ${params.terminalHandle} ownership changed during transfer.`
      )
    }
  }
}

function remoteAttachmentOwnsAgentTerminal(effectsJson: string, terminalHandle: string): boolean {
  try {
    const effects = JSON.parse(effectsJson) as unknown
    if (!Array.isArray(effects)) {
      return true
    }
    return effects.some(
      (effect) =>
        Boolean(effect) &&
        typeof effect === 'object' &&
        (effect as { kind?: string }).kind === 'terminal' &&
        (effect as { role?: string }).role === 'agent' &&
        ['created', 'reused_agent_terminal'].includes(
          (effect as { action?: string }).action ?? ''
        ) &&
        (effect as { id?: string }).id === terminalHandle
    )
  } catch {
    return true
  }
}
