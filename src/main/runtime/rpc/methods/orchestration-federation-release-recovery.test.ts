import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_FEDERATION_RELEASE_METHODS } from './orchestration-federation-release-control'
import {
  configureFederatedReleaseTestRuntime,
  FEDERATED_RELEASE_TEST_HANDLE as HANDLE,
  FEDERATED_RELEASE_TEST_INCARNATION as INCARNATION,
  FEDERATED_RELEASE_TEST_PANE_KEY as PANE_KEY
} from './orchestration-federation-release-test-runtime'

describe('federated worker release recovery authority', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    configureFederatedReleaseTestRuntime(runtime)
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  function createSettledAttachment(dispatchId: string): void {
    db.createRemoteDispatchAttachment({
      dispatchId,
      taskId: `task_${dispatchId}`,
      homePeerFingerprint: 'run-home-device-token',
      protocolVersion: 3,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'run-home-device-token',
        requestId: `attach_${dispatchId}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `payload_${dispatchId}`
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
      worktreeId: 'repo::windows-worktree',
      terminalHandle: HANDLE,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', role: 'agent', action: 'created', id: HANDLE }]
    })
    db.markRemoteAttachmentReady(dispatchId)
    db.settleRemoteAttachmentInRelayTransaction(dispatchId, 'succeeded')
  }

  it('does not let input on a replacement incarnation erase the prior archive', () => {
    const dispatchId = 'ctx_replacement_input'
    createSettledAttachment(dispatchId)
    db.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET archive_kind = 'terminal_tail', archive_content = '["prior output"]',
             archive_source = 'terminal', archive_status = 'captured'
         WHERE dispatch_id = ?`
      )
      .run(dispatchId)

    expect(db.markRemoteAttachmentUserOwned(PANE_KEY, 'windows_runtime:pty:replacement')).toBe(0)
    expect(db.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      release_state: 'not_requested',
      archive_content: '["prior output"]'
    })
  })

  it('fences a reminted current incarnation hidden by an exact stale pane row', () => {
    const staleDispatchId = 'ctx_stale_exact_pane'
    const currentDispatchId = 'ctx_current_reminted_pane'
    createSettledAttachment(staleDispatchId)
    db.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET process_incarnation = 'windows_runtime:pty:stale',
             archive_kind = 'terminal_tail', archive_content = '["prior output"]',
             archive_source = 'terminal', archive_status = 'captured'
         WHERE dispatch_id = ?`
      )
      .run(staleDispatchId)
    createSettledAttachment(currentDispatchId)
    db.db
      .prepare('UPDATE remote_dispatch_attachments SET pane_key = ? WHERE dispatch_id = ?')
      .run(`tab_reminted:${PANE_KEY.split(':')[1]}`, currentDispatchId)

    expect(db.markRemoteAttachmentUserOwned(PANE_KEY, INCARNATION)).toBe(1)
    expect(db.getRemoteDispatchAttachment(staleDispatchId)).toMatchObject({
      release_state: 'not_requested',
      archive_content: '["prior output"]'
    })
    expect(db.getRemoteDispatchAttachment(currentDispatchId)).toMatchObject({
      release_state: 'retained',
      release_error: 'user_takeover'
    })
  })

  it('retries an unknown close receipt against the persisted SSH process owner', async () => {
    const dispatchId = 'ctx_ssh_close_retry'
    createSettledAttachment(dispatchId)
    db.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET release_state = 'unknown', release_request_id = 'ssh_close_retry',
             release_error = 'connection lost', host_scope = ?,
             archive_kind = 'terminal_tail', archive_content = '["remote output"]',
             archive_source = 'terminal', archive_status = 'captured'
         WHERE dispatch_id = ?`
      )
      .run(JSON.stringify({ kind: 'ssh', targetId: 'ssh-prod' }), dispatchId)
    vi.mocked(runtime.showTerminal).mockRejectedValueOnce(new Error('terminal missing'))
    const liveness = vi
      .spyOn(runtime, 'inspectTerminalProcessIncarnationLiveness')
      .mockResolvedValue('exited')

    await expect(
      ORCHESTRATION_FEDERATION_RELEASE_METHODS[0].handler({ dispatchId }, {
        runtime,
        authenticatedCallerFingerprint: 'run-home-device-token',
        orchestrationMutation: { requestId: 'ssh_close_retry' }
      } as never)
    ).resolves.toMatchObject({ state: 'released', processAction: 'none' })
    expect(liveness).toHaveBeenCalledWith(
      INCARNATION,
      JSON.stringify({ kind: 'ssh', targetId: 'ssh-prod' })
    )
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
  })
})
