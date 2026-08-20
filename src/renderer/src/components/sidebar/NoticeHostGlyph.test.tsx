// @vitest-environment happy-dom

/**
 * Notice rows reuse the worktree card's host indicator so one project's rows
 * read the same way wherever they appear: a server glyph with a "Project on …"
 * tooltip, nothing at all for local.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import NoticeHostGlyph from './NoticeHostGlyph'
import en from '../../i18n/locales/en.json'

const runtimeStatusByEnvironmentId = new Map<string, { status?: unknown }>()

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ runtimeStatusByEnvironmentId })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-testid="tooltip">{children}</span>
  )
}))

const roots: Root[] = []

async function render(hostId: string, hostLabel = 'openclaw'): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<NoticeHostGlyph hostId={hostId as never} hostLabel={hostLabel} />)
  })
  return container
}

describe('NoticeHostGlyph', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    runtimeStatusByEnvironmentId.clear()
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => act(() => root.unmount()))
    document.body.replaceChildren()
  })

  it('names the SSH host it would act on', async () => {
    const container = await render('ssh:openclaw-target')

    expect(container.querySelector('[data-notice-host-kind="ssh"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe(
      'Project on SSH host openclaw'
    )
  })

  it('names the paired runtime separately from the SSH host of the same name', async () => {
    runtimeStatusByEnvironmentId.set('openclaw-env', { status: 'ready' })
    const container = await render('runtime:openclaw-env')

    expect(container.querySelector('[data-notice-host-kind="runtime"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe(
      'Project on openclaw'
    )
  })

  it('marks a paired runtime with no live status as disconnected', async () => {
    const container = await render('runtime:openclaw-env')

    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe(
      'openclaw disconnected'
    )
  })

  it('gives the local host the monitor glyph the run-target rows use', async () => {
    const container = await render('local', 'Local Mac')

    expect(container.querySelector('[data-notice-host-kind="local"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="tooltip"]')?.textContent).toBe(
      'Project on this host'
    )
  })

  it('draws one glyph vocabulary: a monitor for local, a server for remote', async () => {
    const local = await render('local', 'Local Mac')
    const remote = await render('ssh:openclaw-target')

    const glyph = (container: HTMLDivElement): string =>
      container.querySelector('svg')?.getAttribute('class') ?? ''
    // The same vocabulary the run-target rows use: this computer vs a server.
    expect(glyph(local)).toContain('lucide-monitor')
    expect(glyph(remote)).toContain('lucide-server')
    // Same size and tone tokens, so neither row reads as decorated.
    const tokens = (value: string): string[] =>
      value.split(' ').filter((entry) => !entry.startsWith('lucide'))
    expect(tokens(glyph(local))).toEqual(tokens(glyph(remote)))
  })

  it('keeps its copy in the English catalog', async () => {
    // A key referenced only in the component silently falls back to its inline
    // default and never reaches translators.
    expect(en.auto.components.sidebar.NoticeHostGlyph).toMatchObject({
      hostDisconnected: '{{hostName}} disconnected',
      sshHostProject: 'Project on SSH host {{hostName}}',
      localHostProject: 'Project on this host',
      runtimeHostProject: 'Project on {{hostName}}'
    })
  })
})
