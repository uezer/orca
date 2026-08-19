import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'

export const FEDERATED_RELEASE_TEST_HANDLE = 'term_windows_worker'
export const FEDERATED_RELEASE_TEST_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
export const FEDERATED_RELEASE_TEST_INCARNATION = 'windows_runtime:pty:1'

export function configureFederatedReleaseTestRuntime(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'windows-repo', kind: 'git' } as never)
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'repo::windows-worktree',
    repoId: 'repo'
  } as never)
  vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: FEDERATED_RELEASE_TEST_HANDLE
  } as never)
  vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
    worktree: { id: 'repo::windows-worktree', repoId: 'repo' },
    startupTerminal: { spawned: true, handle: FEDERATED_RELEASE_TEST_HANDLE },
    setupReceipt: {
      requested: 'run',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
    }
  } as never)
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [{ handle: FEDERATED_RELEASE_TEST_HANDLE, title: 'Codex' }],
    totalCount: 1,
    truncated: false
  } as never)
  vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
    handle: FEDERATED_RELEASE_TEST_HANDLE,
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(FEDERATED_RELEASE_TEST_PANE_KEY)
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(
    FEDERATED_RELEASE_TEST_INCARNATION
  )
  vi.spyOn(runtime, 'resolveTerminalPane').mockReturnValue({
    handle: FEDERATED_RELEASE_TEST_HANDLE,
    tabId: 'tab_worker',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ptyId: 'pty_worker'
  })
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
    terminalHandle: FEDERATED_RELEASE_TEST_HANDLE,
    paneKey: FEDERATED_RELEASE_TEST_PANE_KEY,
    processIncarnation: FEDERATED_RELEASE_TEST_INCARNATION,
    hostScope: { kind: 'local', hostId: 'local' }
  } as never)
  vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
  vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
    handle: FEDERATED_RELEASE_TEST_HANDLE,
    accepted: true,
    bytesWritten: 1
  })
  vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
    handle: FEDERATED_RELEASE_TEST_HANDLE,
    worktreeId: 'repo::windows-worktree',
    connected: true,
    status: 'running'
  } as never)
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle: FEDERATED_RELEASE_TEST_HANDLE,
    status: 'running',
    tail: ['remote output'],
    entries: [{ cursor: 1, text: 'remote output' }],
    nextCursor: '1',
    limited: false,
    truncated: false
  } as never)
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
    handle: FEDERATED_RELEASE_TEST_HANDLE,
    tabId: 'tab-windows-worker',
    ptyKilled: true
  } as never)
}
