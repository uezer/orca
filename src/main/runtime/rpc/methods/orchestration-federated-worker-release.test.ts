import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import {
  ORCHESTRATION_CONTRACT_VERSION,
  ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../orchestration/environment-transport'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { createFederationWorkerStartRequest as startRequest } from './orchestration-federation-test-request'
import { ORCHESTRATION_FEDERATION_RELEASE_METHODS } from './orchestration-federation-release-control'
import {
  configureFederatedReleaseTestRuntime,
  FEDERATED_RELEASE_TEST_HANDLE as HANDLE,
  FEDERATED_RELEASE_TEST_INCARNATION as INCARNATION,
  FEDERATED_RELEASE_TEST_PANE_KEY as PANE_KEY
} from './orchestration-federation-release-test-runtime'

describe('federated worker terminal release', () => {
  let homeDb: OrchestrationDb
  let workerDb: OrchestrationDb
  let homeRuntime: OrcaRuntimeService
  let workerRuntime: OrcaRuntimeService
  let homeDispatcher: RpcDispatcher
  let workerDispatcher: RpcDispatcher
  let workerCapabilities: string[]
  let loseNextReleaseResponse: boolean
  let failNextStatus: boolean

  beforeEach(() => {
    homeDb = new OrchestrationDb(':memory:')
    workerDb = new OrchestrationDb(':memory:')
    workerRuntime = new OrcaRuntimeService()
    workerRuntime.setOrchestrationDb(workerDb)
    configureFederatedReleaseTestRuntime(workerRuntime)
    workerDispatcher = new RpcDispatcher({ runtime: workerRuntime, methods: ORCHESTRATION_METHODS })
    workerCapabilities = [...(workerRuntime.getStatus().capabilities ?? [])]
    loseNextReleaseResponse = false
    failNextStatus = false
    const transport: OrchestrationEnvironmentTransport = {
      resolve: () => ({
        environmentId: 'environment_windows',
        name: 'windows',
        peerFingerprint: 'windows_peer_fingerprint'
      }),
      call: async (_selector, method, params, _timeoutMs, envelope) => {
        if (method === 'status.get') {
          if (failNextStatus) {
            failNextStatus = false
            throw new Error('worker server unavailable')
          }
          return {
            id: 'status',
            ok: true,
            result: { ...workerRuntime.getStatus(), capabilities: workerCapabilities },
            _meta: { runtimeId: workerRuntime.getRuntimeId() }
          }
        }
        const response = (await workerDispatcher.dispatch({
          id: `remote_${method}`,
          authToken: 'run-home-device-token',
          method,
          params,
          orchestrationContractVersion: envelope?.orchestrationContractVersion,
          orchestrationRequestId: envelope?.orchestrationRequestId
        })) as RuntimeRpcResponse<unknown>
        if (method === 'orchestration.federationRelease' && loseNextReleaseResponse) {
          loseNextReleaseResponse = false
          throw new Error('connection lost after release')
        }
        return response
      }
    }
    homeRuntime = new OrcaRuntimeService(null, undefined, {
      orchestrationEnvironmentTransport: transport
    })
    homeRuntime.setOrchestrationDb(homeDb)
    homeDispatcher = new RpcDispatcher({ runtime: homeRuntime, methods: ORCHESTRATION_METHODS })
    vi.spyOn(homeRuntime, 'getTerminalPaneKey').mockReturnValue(
      'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
  })

  afterEach(() => {
    homeRuntime.stopOrchestrationFederationRelay()
    homeDb.close()
    workerDb.close()
  })

  function createHomeTask() {
    const run = homeDb.createRun({
      objective: 'Windows to WSL',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    return homeDb.createTask({ spec: 'Finish remote work', runId: run.id })
  }

  async function startAndSettle() {
    const task = createHomeTask()
    const started = await homeDispatcher.dispatch(
      startRequest(task.id, {
        worktree: 'id:repo::windows-worktree',
        repo: undefined,
        name: undefined
      })
    )
    expect(started).toMatchObject({ ok: true, result: { state: 'ready' } })
    const dispatch = homeDb.getDispatchContext(task.id)!
    expect(homeDb.getWorkerTerminalResourceByOwner(dispatch.id)).toMatchObject({
      terminal_handle: HANDLE,
      pane_key: PANE_KEY,
      process_incarnation: INCARNATION,
      ownership_state: 'owned'
    })
    expect(
      homeDb.settleWorkerReport({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded',
        result: 'done'
      })
    ).toMatchObject({ action: 'settled' })
    workerDb.settleRemoteAttachmentInRelayTransaction(dispatch.id, 'succeeded')
    return dispatch.id
  }

  async function release(dispatchId: string, requestId: string) {
    return homeDispatcher.dispatch({
      id: requestId,
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: requestId,
      method: 'orchestration.workerRelease',
      params: { dispatch: dispatchId }
    })
  }

  async function reportRemoteUserInput(requestId: string) {
    return workerDispatcher.dispatch({
      id: requestId,
      authToken: 'run-home-device-token',
      method: 'orchestration.workerTerminalUserInput',
      params: { paneKey: PANE_KEY }
    })
  }

  function createReplacementAttachment(dispatchId: string): void {
    workerDb.createRemoteDispatchAttachment({
      dispatchId,
      taskId: `task_${dispatchId}`,
      homePeerFingerprint: 'run-home-device-token',
      protocolVersion: 3,
      runtimeEpoch: workerRuntime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'run-home-device-token',
        requestId: `attach_${dispatchId}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `payload_${dispatchId}`
      }
    })
  }

  it('archives before closing the exact terminal and settles retries once', async () => {
    const dispatchId = await startAndSettle()

    const released = await release(dispatchId, 'release_once')

    expect(released).toMatchObject({
      ok: true,
      result: {
        state: 'released',
        processAction: 'closed_agent_terminal',
        archive: { source: 'terminal', status: 'captured' }
      }
    })
    expect(workerRuntime.readTerminal).toHaveBeenCalledWith(HANDLE, expect.anything())
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
    expect(workerRuntime.closeTerminal).toHaveBeenCalledWith(HANDLE)
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      release_state: 'released',
      archive_kind: 'terminal_tail',
      archive_content: expect.stringContaining('remote output'),
      archive_source: 'terminal',
      archive_status: 'captured'
    })
    const durableReleaseReceipt = workerDb.db
      .prepare(
        `SELECT request_id, receipt FROM mutation_receipts
         WHERE method = 'orchestration.federationRelease' AND state = 'completed'`
      )
      .get() as { request_id: string; receipt: string }
    expect(durableReleaseReceipt.receipt).not.toContain('remote output')
    await expect(
      workerDispatcher.dispatch({
        id: 'release_from_compact_receipt',
        authToken: 'run-home-device-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: durableReleaseReceipt.request_id,
        method: 'orchestration.federationRelease',
        params: { dispatchId }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        state: 'already_released',
        archive: { content: expect.stringContaining('remote output') },
        mutation: { replayed: true }
      }
    })
    workerDb.db
      .prepare("DELETE FROM mutation_receipts WHERE method = 'orchestration.federationRelease'")
      .run()
    await expect(
      workerDispatcher.dispatch({
        id: 'release_after_receipt_eviction',
        authToken: 'run-home-device-token',
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: 'release_after_receipt_eviction',
        method: 'orchestration.federationRelease',
        params: { dispatchId }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        state: 'already_released',
        archive: {
          source: 'terminal',
          status: 'captured',
          content: expect.stringContaining('remote output')
        }
      }
    })

    const archived = await homeDispatcher.dispatch({
      id: 'read_archive',
      authToken: 'coordinator-token',
      method: 'orchestration.workerRead',
      params: { dispatch: dispatchId, source: 'terminal' }
    })
    expect(archived).toMatchObject({
      ok: true,
      result: { source: 'terminal', archived: true, terminal: { tail: ['remote output'] } }
    })

    await expect(release(dispatchId, 'release_again')).resolves.toMatchObject({
      ok: true,
      result: { state: 'already_released', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
  })

  it('owns the startup terminal created with a new remote worktree', async () => {
    const task = createHomeTask()

    await expect(homeDispatcher.dispatch(startRequest(task.id))).resolves.toMatchObject({
      ok: true,
      result: { state: 'ready' }
    })
    const dispatch = homeDb.getDispatchContext(task.id)!
    expect(homeDb.getWorkerTerminalResourceByOwner(dispatch.id)).toMatchObject({
      terminal_handle: HANDLE,
      ownership_state: 'owned'
    })
  })

  it('keeps ownership retained when the worker host lacks release capability', async () => {
    const dispatchId = await startAndSettle()
    workerCapabilities = workerCapabilities.filter(
      (capability) => capability !== ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY
    )

    await expect(release(dispatchId, 'release_old_host')).resolves.toMatchObject({
      ok: true,
      result: {
        state: 'retained',
        reason: 'federation_unsupported',
        processAction: 'none'
      }
    })
    expect(workerRuntime.readTerminal).not.toHaveBeenCalled()
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('retains a remote terminal after direct user input on its owning host', async () => {
    const dispatchId = await startAndSettle()

    await expect(reportRemoteUserInput('remote_user_takeover')).resolves.toMatchObject({
      ok: true,
      result: { changed: 1 }
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      release_state: 'retained',
      release_error: 'user_takeover'
    })
    await expect(release(dispatchId, 'release_after_remote_user_takeover')).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_takeover', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()

    const replacementId = 'ctx_after_user_takeover'
    createReplacementAttachment(replacementId)
    expect(() =>
      workerDb.prepareRemoteAttachmentAuthority({
        dispatchId: replacementId,
        paneKey: PANE_KEY,
        processIncarnation: INCARNATION,
        worktreeId: 'repo::windows-worktree',
        terminalHandle: HANDLE,
        setupState: 'not_applicable',
        effects: [{ kind: 'terminal', role: 'agent', action: 'reused', id: HANDLE }]
      })
    ).not.toThrow()
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      release_state: 'released',
      capability_hash: null,
      release_error: 'user_takeover'
    })
  })

  it('replays a lost release response without closing twice', async () => {
    const dispatchId = await startAndSettle()
    loseNextReleaseResponse = true

    await expect(release(dispatchId, 'release_lost')).resolves.toMatchObject({
      ok: true,
      result: { state: 'release_unknown', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()

    await expect(release(dispatchId, 'release_recovered')).resolves.toMatchObject({
      ok: true,
      result: { state: 'already_released', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
    expect(homeDb.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
    await expect(
      homeDispatcher.dispatch({
        id: 'read_lost_response_archive',
        authToken: 'coordinator-token',
        method: 'orchestration.workerRead',
        params: { dispatch: dispatchId, source: 'terminal' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { source: 'terminal', archived: true, terminal: { tail: ['remote output'] } }
    })
  })

  it('reclaims a release stranded after archive commit with the same request identity', async () => {
    const dispatchId = await startAndSettle()
    workerDb.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET release_state = 'releasing', release_request_id = 'stranded_release',
             archive_kind = 'terminal_tail', archive_content = '["remote output"]',
             archive_source = 'terminal', archive_status = 'captured'
         WHERE dispatch_id = ?`
      )
      .run(dispatchId)
    const releaseMethod = ORCHESTRATION_FEDERATION_RELEASE_METHODS[0]

    await expect(
      releaseMethod.handler({ dispatchId }, {
        runtime: workerRuntime,
        authenticatedCallerFingerprint:
          workerDb.getRemoteDispatchAttachment(dispatchId)!.home_peer_fingerprint,
        orchestrationMutation: { requestId: 'stranded_release' }
      } as never)
    ).resolves.toMatchObject({ state: 'released', processAction: 'closed_agent_terminal' })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('released')
  })

  it('settles a release crash after close from archived output and dead-process inventory', async () => {
    const dispatchId = await startAndSettle()
    workerDb.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET release_state = 'releasing', release_request_id = 'closed_before_crash',
             release_error = 'close_committed', archive_kind = 'terminal_tail',
             archive_content = '["remote output"]', archive_source = 'terminal',
             archive_status = 'captured' WHERE dispatch_id = ?`
      )
      .run(dispatchId)
    vi.mocked(workerRuntime.showTerminal).mockRejectedValueOnce(new Error('terminal missing'))
    vi.spyOn(workerRuntime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')
    const releaseMethod = ORCHESTRATION_FEDERATION_RELEASE_METHODS[0]

    await expect(
      releaseMethod.handler({ dispatchId }, {
        runtime: workerRuntime,
        authenticatedCallerFingerprint:
          workerDb.getRemoteDispatchAttachment(dispatchId)!.home_peer_fingerprint,
        orchestrationMutation: { requestId: 'closed_before_crash' }
      } as never)
    ).resolves.toMatchObject({
      state: 'released',
      processAction: 'none',
      archive: { content: expect.stringContaining('remote output') }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps a pre-mutation connectivity failure retryable', async () => {
    const dispatchId = await startAndSettle()
    failNextStatus = true

    await expect(release(dispatchId, 'release_offline')).resolves.toMatchObject({
      ok: true,
      result: { state: 'release_pending', processAction: 'none' }
    })
    expect(homeDb.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('requested')
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()

    await expect(release(dispatchId, 'release_after_reconnect')).resolves.toMatchObject({
      ok: true,
      result: { state: 'released' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
  })

  it('keeps a local release pending when the remote owner is busy', async () => {
    const dispatchId = await startAndSettle()
    workerDb.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET release_state = 'requested', release_request_id = 'another-home-request'
         WHERE dispatch_id = ?`
      )
      .run(dispatchId)

    await expect(release(dispatchId, 'release_busy')).resolves.toMatchObject({
      ok: true,
      result: { state: 'release_pending', processAction: 'none' }
    })
    expect(homeDb.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
      release_state: 'releasing'
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('rejects exact reuse while a settled remote attachment still owns the terminal', async () => {
    const dispatchId = await startAndSettle()
    const replacementId = 'ctx_replacement'
    createReplacementAttachment(replacementId)

    expect(() =>
      workerDb.prepareRemoteAttachmentAuthority({
        dispatchId: replacementId,
        paneKey: PANE_KEY,
        processIncarnation: INCARNATION,
        worktreeId: 'repo::windows-worktree',
        terminalHandle: HANDLE,
        setupState: 'not_applicable',
        effects: [{ kind: 'terminal', role: 'agent', action: 'reused', id: HANDLE }]
      })
    ).toThrow(/owned by another remote Dispatch/)
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('not_requested')
  })

  it('transfers exact explicit reuse from a settled external attachment', async () => {
    const dispatchId = await startAndSettle()
    workerDb.db
      .prepare(
        `UPDATE remote_dispatch_attachments SET effects = ?, residual_resources = '[]'
         WHERE dispatch_id = ?`
      )
      .run(
        JSON.stringify([{ kind: 'terminal', role: 'agent', action: 'reused', id: HANDLE }]),
        dispatchId
      )
    const replacementId = 'ctx_external_replacement'
    createReplacementAttachment(replacementId)

    expect(() =>
      workerDb.prepareRemoteAttachmentAuthority({
        dispatchId: replacementId,
        paneKey: PANE_KEY,
        processIncarnation: INCARNATION,
        worktreeId: 'repo::windows-worktree',
        terminalHandle: HANDLE,
        setupState: 'not_applicable',
        effects: [{ kind: 'terminal', role: 'agent', action: 'reused', id: HANDLE }]
      })
    ).not.toThrow()
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
      release_state: 'released',
      capability_hash: null
    })
    expect(
      workerDb.isRemoteAttachmentProcessCurrent({
        dispatchId: replacementId,
        paneKey: PANE_KEY,
        processIncarnation: INCARNATION
      })
    ).toBe(true)
  })

  it('rejects exact reuse while the prior remote attachment is active', async () => {
    const dispatchId = await startAndSettle()
    workerDb.db
      .prepare("UPDATE remote_dispatch_attachments SET state = 'ready' WHERE dispatch_id = ?")
      .run(dispatchId)
    const replacementId = 'ctx_active_replacement'
    createReplacementAttachment(replacementId)

    expect(() =>
      workerDb.prepareRemoteAttachmentAuthority({
        dispatchId: replacementId,
        paneKey: PANE_KEY,
        processIncarnation: INCARNATION,
        worktreeId: 'repo::windows-worktree',
        terminalHandle: HANDLE,
        setupState: 'not_applicable',
        effects: [{ kind: 'terminal', role: 'agent', action: 'reused', id: HANDLE }]
      })
    ).toThrow(/owned by another remote Dispatch/)
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('not_requested')
  })

  it('rejects exact terminal reuse while the remote release lease is active', async () => {
    const dispatchId = await startAndSettle()
    let finishRead!: () => void
    vi.mocked(workerRuntime.readTerminal).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = () => resolve({ handle: HANDLE, status: 'running', tail: [] } as never)
      })
    )
    const releasing = release(dispatchId, 'release_during_reuse')
    await vi.waitFor(() =>
      expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('requested')
    )
    const replacementId = 'ctx_release_race_replacement'
    createReplacementAttachment(replacementId)

    expect(() =>
      workerDb.prepareRemoteAttachmentAuthority({
        dispatchId: replacementId,
        paneKey: PANE_KEY,
        processIncarnation: INCARNATION,
        worktreeId: 'repo::windows-worktree',
        terminalHandle: HANDLE,
        setupState: 'not_applicable',
        effects: [{ kind: 'terminal', role: 'agent', action: 'reused', id: HANDLE }]
      })
    ).toThrow(/release in progress/)

    finishRead()
    await expect(releasing).resolves.toMatchObject({ ok: true, result: { state: 'released' } })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
  })

  it('lets direct remote user input cancel release during output capture', async () => {
    const dispatchId = await startAndSettle()
    let finishRead!: () => void
    vi.mocked(workerRuntime.readTerminal).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = () => resolve({ handle: HANDLE, status: 'running', tail: [] } as never)
      })
    )
    const releasing = release(dispatchId, 'release_during_remote_user_takeover')
    await vi.waitFor(() =>
      expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('requested')
    )

    await expect(reportRemoteUserInput('remote_user_takeover_race')).resolves.toMatchObject({
      ok: true,
      result: { changed: 1 }
    })
    finishRead()

    await expect(releasing).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_takeover', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('preserves user takeover when output capture fails concurrently', async () => {
    const dispatchId = await startAndSettle()
    let failRead!: () => void
    vi.mocked(workerRuntime.readTerminal).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failRead = () => reject(new Error('capture failed'))
      })
    )
    const releasing = release(dispatchId, 'release_during_failed_capture')
    await vi.waitFor(() =>
      expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('requested')
    )

    await expect(reportRemoteUserInput('takeover_during_failed_capture')).resolves.toMatchObject({
      ok: true,
      result: { changed: 1 }
    })
    failRead()

    await expect(releasing).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_takeover', processAction: 'none' }
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_error).toBe('user_takeover')
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('preserves user takeover when terminal inspection fails concurrently', async () => {
    const dispatchId = await startAndSettle()
    let failInspection!: () => void
    vi.mocked(workerRuntime.showTerminal).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failInspection = () => reject(new Error('inspection failed'))
      })
    )
    const releasing = release(dispatchId, 'release_during_failed_inspection')
    await vi.waitFor(() =>
      expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('requested')
    )

    await expect(reportRemoteUserInput('takeover_during_failed_inspection')).resolves.toMatchObject(
      { ok: true, result: { changed: 1 } }
    )
    failInspection()

    await expect(releasing).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_takeover', processAction: 'none' }
    })
    expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_error).toBe('user_takeover')
    expect(workerRuntime.readTerminal).not.toHaveBeenCalled()
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('lets direct remote user input cancel after archive commit but before close commit', async () => {
    const dispatchId = await startAndSettle()
    let finishInspection!: () => void
    const terminal = {
      handle: HANDLE,
      worktreeId: 'repo::windows-worktree',
      connected: true,
      status: 'running'
    } as never
    vi.mocked(workerRuntime.showTerminal)
      .mockResolvedValueOnce(terminal)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishInspection = () => resolve(terminal)
        })
      )
    const releasing = release(dispatchId, 'release_after_archive_takeover')
    await vi.waitFor(() =>
      expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('releasing')
    )

    await expect(
      reportRemoteUserInput('remote_user_takeover_after_archive')
    ).resolves.toMatchObject({
      ok: true,
      result: { changed: 1 }
    })
    finishInspection()

    await expect(releasing).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'user_takeover', processAction: 'none' }
    })
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('does not close when process identity changes during archive capture', async () => {
    const dispatchId = await startAndSettle()
    vi.mocked(workerRuntime.getTerminalProcessIncarnation)
      .mockReturnValueOnce(INCARNATION)
      .mockReturnValue('replacement:pty:2')

    await expect(release(dispatchId, 'release_identity_race')).resolves.toMatchObject({
      ok: true,
      result: { state: 'retained', reason: 'identity_unproven', processAction: 'none' }
    })
    expect(workerRuntime.readTerminal).toHaveBeenCalledOnce()
    expect(workerRuntime.closeTerminal).not.toHaveBeenCalled()
  })

  it('fences retain once remote release delegation is committed', async () => {
    const dispatchId = await startAndSettle()
    let finishRead!: () => void
    vi.mocked(workerRuntime.readTerminal).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = () =>
          resolve({
            handle: HANDLE,
            status: 'running',
            tail: ['remote output'],
            entries: [{ cursor: 1, text: 'remote output' }],
            nextCursor: '1',
            limited: false,
            truncated: false
          } as never)
      })
    )
    const releasing = release(dispatchId, 'release_with_retain_race')
    await vi.waitFor(() =>
      expect(homeDb.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('releasing')
    )

    const retained = await homeDispatcher.dispatch({
      id: 'retain_during_release',
      authToken: 'coordinator-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'retain_during_release',
      method: 'orchestration.workerRetain',
      params: { dispatch: dispatchId }
    })
    expect(retained).toMatchObject({
      ok: true,
      result: { state: 'release_pending', processAction: 'none' }
    })

    finishRead()
    await expect(releasing).resolves.toMatchObject({
      ok: true,
      result: { state: 'released' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
  })

  it('serializes distinct remote release request identities', async () => {
    const dispatchId = await startAndSettle()
    let finishRead!: () => void
    vi.mocked(workerRuntime.readTerminal).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = () =>
          resolve({
            handle: HANDLE,
            status: 'running',
            tail: ['remote output'],
            entries: [{ cursor: 1, text: 'remote output' }],
            nextCursor: '1',
            limited: false,
            truncated: false
          } as never)
      })
    )
    const first = workerDispatcher.dispatch({
      id: 'remote_release_one',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_one',
      method: 'orchestration.federationRelease',
      params: { dispatchId }
    })
    await vi.waitFor(() =>
      expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('requested')
    )
    const concurrentDispatcher = new RpcDispatcher({
      runtime: workerRuntime,
      methods: ORCHESTRATION_METHODS
    })
    const second = await concurrentDispatcher.dispatch({
      id: 'remote_release_two',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'remote_release_two',
      method: 'orchestration.federationRelease',
      params: { dispatchId }
    })
    expect(second).toMatchObject({ ok: true, result: { state: 'release_pending' } })

    finishRead()
    await expect(first).resolves.toMatchObject({
      ok: true,
      result: { state: 'released' }
    })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent retries with the same remote request identity', async () => {
    const dispatchId = await startAndSettle()
    let finishRead!: () => void
    vi.mocked(workerRuntime.readTerminal).mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = () => resolve({ handle: HANDLE, status: 'running', tail: [] } as never)
      })
    )
    const releaseMethod = ORCHESTRATION_FEDERATION_RELEASE_METHODS[0]
    const callerFingerprint =
      workerDb.getRemoteDispatchAttachment(dispatchId)!.home_peer_fingerprint
    const releaseContext = {
      runtime: workerRuntime,
      authenticatedCallerFingerprint: callerFingerprint,
      orchestrationMutation: { requestId: 'same_release_request' }
    } as never
    const first = releaseMethod.handler({ dispatchId }, releaseContext)
    await vi.waitFor(() =>
      expect(workerDb.getRemoteDispatchAttachment(dispatchId)?.release_state).toBe('requested')
    )
    const second = await releaseMethod.handler({ dispatchId }, releaseContext)
    expect(second).toMatchObject({ state: 'release_pending' })

    finishRead()
    await expect(first).resolves.toMatchObject({ state: 'released' })
    expect(workerRuntime.closeTerminal).toHaveBeenCalledOnce()
  })

  it('does not cache a transient remote release response', async () => {
    const dispatchId = await startAndSettle()
    workerDb.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET release_state = 'requested', release_request_id = 'other-request'
         WHERE dispatch_id = ?`
      )
      .run(dispatchId)

    const first = await workerDispatcher.dispatch({
      id: 'transient_release_one',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'transient_release_request',
      method: 'orchestration.federationRelease',
      params: { dispatchId }
    })
    expect(first).toMatchObject({ ok: true, result: { state: 'release_pending' } })

    workerDb.db
      .prepare(
        `UPDATE remote_dispatch_attachments
         SET release_state = 'not_requested', release_request_id = NULL
         WHERE dispatch_id = ?`
      )
      .run(dispatchId)
    const retried = await workerDispatcher.dispatch({
      id: 'transient_release_two',
      authToken: 'run-home-device-token',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'transient_release_request',
      method: 'orchestration.federationRelease',
      params: { dispatchId }
    })
    expect(retried).toMatchObject({
      ok: true,
      result: { state: 'released', mutation: { replayed: false } }
    })
  })
})
