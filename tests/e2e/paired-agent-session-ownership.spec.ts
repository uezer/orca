import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedWebClient,
  type PairedWebClient
} from './helpers/paired-electron-client'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import type { RuntimeTerminalSummary } from '../../src/shared/runtime-types'

type AgentSessionResult = {
  disposition: 'created' | 'adopted' | 'replayed'
  terminal: RuntimeTerminalSummary
}

type SpawnRecord = {
  pid: number
  ppid: number
  spawnedAt: number
  argv: string[]
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-agent-ownership-'))
const spawnMarkerPath = path.join(scratch, 'agent-spawns.txt')
const inputMarkerPath = path.join(scratch, 'agent-input.txt')
const lifecycleMarkerPath = path.join(scratch, 'agent-lifecycle.txt')
const exitTriggerPath = path.join(scratch, 'exit-agent')
const fixtureScript = path.join(
  process.cwd(),
  'config',
  'scripts',
  'remote-agent-session-repro-fixture.mjs'
)

test.use({
  launchEnv: {
    ORCA_REPRO_EXIT_TRIGGER: exitTriggerPath,
    ORCA_REPRO_INPUT_MARKER: inputMarkerPath,
    ORCA_REPRO_LIFECYCLE_MARKER: lifecycleMarkerPath,
    ORCA_REPRO_SPAWN_MARKER: spawnMarkerPath
  }
})

test.beforeEach(() => {
  for (const markerPath of [
    spawnMarkerPath,
    inputMarkerPath,
    lifecycleMarkerPath,
    exitTriggerPath
  ]) {
    rmSync(markerPath, { force: true })
  }
})

test.afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixtureScript]
  return process.platform === 'win32'
    ? `& ${command.map((value) => `'${value.replaceAll("'", "''")}'`).join(' ')}`
    : command.map(shellQuote).join(' ')
}

function readSpawnRecords(): SpawnRecord[] {
  if (!existsSync(spawnMarkerPath)) {
    return []
  }
  return readFileSync(spawnMarkerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, spawnedAt, ...argvParts] = line.split(':')
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        spawnedAt: Number(spawnedAt),
        argv: JSON.parse(argvParts.join(':')) as string[]
      }
    })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function callClient<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

async function configureFixtureAgent(page: Page): Promise<void> {
  await page.evaluate(async (command) => {
    const settings = await window.api.settings.set({
      agentCmdOverrides: { codex: command },
      defaultTuiAgent: 'codex'
    })
    window.__store?.setState({ settings })
  }, fixtureCommand())
}

async function activeWorktreeId(page: Page): Promise<string> {
  const worktreeId = await page.evaluate(() => window.__store?.getState().activeWorktreeId)
  if (!worktreeId) {
    throw new Error('Renderer has no active worktree')
  }
  return worktreeId
}

async function waitForWorktree(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) =>
            window.__store
              ?.getState()
              .allWorktrees()
              .some((worktree) => worktree.id === id),
          worktreeId
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function listTerminals(page: Page, worktreeId: string): Promise<RuntimeTerminalSummary[]> {
  return (
    await callClient<{ terminals: RuntimeTerminalSummary[] }>(page, 'terminal.list', {
      worktree: `id:${worktreeId}`
    })
  ).terminals
}

async function mirroredTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

async function terminalViewportText(page: Page, tabId: string): Promise<string> {
  return page.evaluate((id) => {
    const pane = window.__paneManagers?.get(id)?.getActivePane?.()
    if (!pane) {
      return ''
    }
    const buffer = pane.terminal.buffer.active
    return Array.from(
      { length: pane.terminal.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    ).join('\n')
  }, tabId)
}

async function attachEvidence(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
    contentType: 'application/json'
  })
}

async function stopTerminal(client: PairedWebClient, worktreeId: string): Promise<void> {
  await callClient(client.page, 'terminal.stop', { worktree: `id:${worktreeId}` }).catch(
    () => undefined
  )
}

test('paired viewer create-with-agent has one backend startup owner @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await configureFixtureAgent(orcaPage)
  const hostWorktreeBefore = await activeWorktreeId(orcaPage)
  const client = await launchPairedWebClient(
    electronApp,
    await createRuntimeDesktopPairingOffer(orcaPage)
  )
  let createdWorktreeId: string | null = null
  try {
    await configureFixtureAgent(client.page)
    await waitForWorktree(client.page, hostWorktreeBefore)
    const workspaceName = `sta-4908-owner-${Date.now()}`
    await client.page.getByRole('button', { name: 'New workspace', exact: true }).click()
    const dialog = client.page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder(/Type a name/i).fill(workspaceName)
    const agent = dialog.locator('[data-agent-combobox-root="true"][role="combobox"]')
    await agent.click()
    await client.page
      .getByRole('option')
      .filter({ hasText: /^Codex/ })
      .click()
    await expect(agent).toContainText('Codex')
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })

    await expect
      .poll(
        () =>
          client.page.evaluate((name) => {
            const state = window.__store?.getState()
            return state
              ?.allWorktrees()
              .find((worktree) => worktree.displayName === name || worktree.name === name)?.id
          }, workspaceName),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    const createdId: unknown = await client.page.evaluate((name) => {
      const state = window.__store?.getState()
      return state
        ?.allWorktrees()
        .find((worktree) => worktree.displayName === name || worktree.name === name)?.id
    }, workspaceName)
    if (typeof createdId !== 'string' || !createdId) {
      throw new Error('Paired creator did not publish the created worktree')
    }
    createdWorktreeId = createdId

    await expect.poll(() => readSpawnRecords(), { timeout: 30_000 }).toHaveLength(1)
    await expect.poll(() => listTerminals(client.page, createdId)).toHaveLength(1)
    const [terminal] = await listTerminals(client.page, createdId)
    if (!terminal?.ptyId) {
      throw new Error('Backend startup terminal did not publish a PTY identity')
    }
    const webTabId = toWebTerminalSurfaceTabId(terminal.tabId)
    await expect.poll(() => mirroredTabIds(client.page, createdId)).toEqual([webTabId])
    await expect.poll(() => mirroredTabIds(orcaPage, createdId)).toEqual([terminal.tabId])
    await client.page.locator(`[role="option"][data-worktree-id="${createdId}"]`).click()
    await expect.poll(() => activeWorktreeId(client.page)).toBe(createdId)
    await expect(client.page.locator('[data-testid="sortable-tab"]')).toHaveCount(1)
    await expect(
      client.page.locator(`[data-terminal-tab-id="${webTabId}"][data-terminal-layout-leaf-ids]`)
    ).toBeVisible()
    await expect
      .poll(() => terminalViewportText(client.page, webTabId), { timeout: 30_000 })
      .toContain('ORCA_REPRO_AGENT_READY')
    expect(await activeWorktreeId(orcaPage)).toBe(hostWorktreeBefore)

    const [spawn] = readSpawnRecords()
    expect(spawn).toBeDefined()
    expect(isProcessAlive(spawn!.pid)).toBe(true)
    expect(spawn!.argv).not.toContain('resume')
    const processInspection = await callClient(client.page, 'terminal.inspectProcess', {
      terminal: terminal.handle
    })
    const authoritativeTabs = await callClient(client.page, 'session.tabs.list', {
      worktree: `id:${createdId}`
    })
    await attachEvidence(testInfo, 'sta-4908-ownership-evidence', {
      hostWorktreeBefore,
      viewerWorktreeAfter: createdId,
      terminal,
      processInspection,
      authoritativeTabs,
      spawn,
      lifecycle: existsSync(lifecycleMarkerPath)
        ? readFileSync(lifecycleMarkerPath, 'utf8').trim().split(/\r?\n/)
        : []
    })
  } finally {
    if (createdWorktreeId) {
      await stopTerminal(client, createdWorktreeId)
    }
    await client.dispose()
  }
})

test('two persistent paired viewers share one live resumed provider session @headful', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(180_000)
  await configureFixtureAgent(orcaPage)
  const worktreeId = await activeWorktreeId(orcaPage)
  const clientA = await launchPairedWebClient(
    electronApp,
    await createRuntimeDesktopPairingOffer(orcaPage)
  )
  let clientB: PairedWebClient | null = null
  let claimedTerminal: RuntimeTerminalSummary | null = null
  try {
    await waitForWorktree(clientA.page, worktreeId)
    clientB = await launchPairedWebClient(
      electronApp,
      await createRuntimeDesktopPairingOffer(orcaPage)
    )
    await waitForWorktree(clientB.page, worktreeId)
    const providerSessionId = `sta-3859-${Date.now()}`
    const request = {
      kind: 'explicit',
      worktree: `id:${worktreeId}`,
      agent: 'codex',
      providerSession: { key: 'session_id', id: providerSessionId },
      presentation: 'focused'
    }
    const [first, second] = await Promise.all([
      callClient<AgentSessionResult>(clientA.page, 'terminal.ensureAgentSession', request),
      callClient<AgentSessionResult>(clientB.page, 'terminal.ensureAgentSession', request)
    ])
    claimedTerminal = first.terminal
    await expect.poll(() => readSpawnRecords(), { timeout: 30_000 }).toHaveLength(1)
    expect([first.disposition, second.disposition].sort()).toEqual(['adopted', 'created'])
    expect(second.terminal).toMatchObject({
      handle: first.terminal.handle,
      tabId: first.terminal.tabId,
      ptyId: first.terminal.ptyId
    })
    const [spawn] = readSpawnRecords()
    expect(spawn).toBeDefined()
    expect(isProcessAlive(spawn!.pid)).toBe(true)
    expect(spawn!.argv).toEqual(expect.arrayContaining(['resume', providerSessionId]))

    const retry = await callClient<AgentSessionResult>(
      clientB.page,
      'terminal.ensureAgentSession',
      request
    )
    expect(retry.disposition).toBe('adopted')
    expect(retry.terminal.handle).toBe(first.terminal.handle)
    expect(readSpawnRecords()).toHaveLength(1)

    const input = `sta-3859-live-owner-${Date.now()}`
    const sent = await callClient<{ send: { accepted: boolean } }>(clientA.page, 'terminal.send', {
      terminal: first.terminal.handle,
      text: `${input}\n`
    })
    expect(sent.send.accepted).toBe(true)
    await expect
      .poll(
        () => existsSync(inputMarkerPath) && readFileSync(inputMarkerPath, 'utf8').includes(input),
        { timeout: 30_000 }
      )
      .toBe(true)
    expect(isProcessAlive(spawn!.pid)).toBe(true)

    const matchingInventory = (await listTerminals(clientA.page, worktreeId)).filter(
      (terminal) => terminal.handle === first.terminal.handle
    )
    expect(matchingInventory).toHaveLength(1)
    await attachEvidence(testInfo, 'sta-3859-ownership-evidence', {
      clientADisposition: first.disposition,
      clientBDisposition: second.disposition,
      retryDisposition: retry.disposition,
      terminal: first.terminal,
      spawn,
      matchingInventory,
      lifecycle: existsSync(lifecycleMarkerPath)
        ? readFileSync(lifecycleMarkerPath, 'utf8').trim().split(/\r?\n/)
        : []
    })
  } finally {
    if (claimedTerminal) {
      await callClient(clientA.page, 'terminal.close', {
        terminal: claimedTerminal.handle
      }).catch(() => undefined)
    }
    await clientB?.dispose()
    await clientA.dispose()
  }
  await expect
    .poll(() => readSpawnRecords().filter((spawn) => isProcessAlive(spawn.pid)))
    .toEqual([])
})
