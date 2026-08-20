import type { ChildProcess } from 'node:child_process'

const DEFAULT_PIPE_QUIET_MS = 500

// Why: agent-browser's Windows daemon inherits capture pipes, so execFile never observes EOF after the CLI exits.
export function armAgentBrowserWindowsPipeRelease(
  child: ChildProcess,
  targetPlatform: NodeJS.Platform = process.platform,
  quietMs = DEFAULT_PIPE_QUIET_MS
): void {
  if (targetPlatform !== 'win32' || typeof child.once !== 'function') {
    return
  }

  const stdout = child.stdout
  const stderr = child.stderr
  let exited = false
  let closed = false
  let quietTimer: NodeJS.Timeout | null = null

  const clearQuietTimer = (): void => {
    if (quietTimer) {
      clearTimeout(quietTimer)
      quietTimer = null
    }
  }
  const releasePipes = (): void => {
    quietTimer = null
    stdout?.destroy()
    stderr?.destroy()
  }
  const scheduleRelease = (): void => {
    if (!exited || closed) {
      return
    }
    clearQuietTimer()
    quietTimer = setTimeout(releasePipes, quietMs)
  }
  const onData = (): void => scheduleRelease()
  const onExit = (): void => {
    exited = true
    scheduleRelease()
  }
  const onClose = (): void => {
    closed = true
    clearQuietTimer()
    stdout?.off('data', onData)
    stderr?.off('data', onData)
  }

  stdout?.on('data', onData)
  stderr?.on('data', onData)
  child.once('exit', onExit)
  child.once('close', onClose)
}
