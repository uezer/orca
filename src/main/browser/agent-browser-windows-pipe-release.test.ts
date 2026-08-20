import { EventEmitter } from 'node:events'
import { execFile, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { armAgentBrowserWindowsPipeRelease } from './agent-browser-windows-pipe-release'

function mockChild(): {
  child: ChildProcess
  emitter: EventEmitter
  stdout: EventEmitter & { destroy: ReturnType<typeof vi.fn> }
  stderr: EventEmitter & { destroy: ReturnType<typeof vi.fn> }
} {
  const emitter = new EventEmitter()
  const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  return {
    child: Object.assign(emitter, { stdout, stderr }) as unknown as ChildProcess,
    emitter,
    stdout,
    stderr
  }
}

describe('armAgentBrowserWindowsPipeRelease', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases inherited pipes after a quiet window following process exit', () => {
    vi.useFakeTimers()
    const { child, emitter, stdout, stderr } = mockChild()
    armAgentBrowserWindowsPipeRelease(child, 'win32', 500)

    emitter.emit('exit', 0, null)
    vi.advanceTimersByTime(400)
    stdout.emit('data', Buffer.from('final output'))
    vi.advanceTimersByTime(499)
    expect(stdout.destroy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(stdout.destroy).toHaveBeenCalledOnce()
    expect(stderr.destroy).toHaveBeenCalledOnce()
  })

  it('leaves normally closed and non-Windows pipes alone', () => {
    vi.useFakeTimers()
    const normal = mockChild()
    armAgentBrowserWindowsPipeRelease(normal.child, 'win32', 10)
    normal.emitter.emit('exit', 0, null)
    normal.emitter.emit('close', 0, null)
    vi.runAllTimers()
    expect(normal.stdout.destroy).not.toHaveBeenCalled()
    expect(normal.stderr.destroy).not.toHaveBeenCalled()

    const posix = mockChild()
    armAgentBrowserWindowsPipeRelease(posix.child, 'linux', 10)
    posix.emitter.emit('exit', 0, null)
    vi.runAllTimers()
    expect(posix.stdout.destroy).not.toHaveBeenCalled()
    expect(posix.stderr.destroy).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'win32')(
    'settles execFile while a detached grandchild still owns inherited pipes',
    async () => {
      const childScript = [
        "const { spawn } = require('node:child_process')",
        "const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { detached: true, stdio: 'inherit', windowsHide: true })",
        'daemon.unref()',
        'process.stdout.write(\'{"success":true}\\n\')'
      ].join(';')
      const startedAt = Date.now()
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          ['-e', childScript],
          { timeout: 3_000 },
          (error, output) => {
            if (error) {
              reject(error)
              return
            }
            resolve(output)
          }
        )
        armAgentBrowserWindowsPipeRelease(child, 'win32', 100)
      })

      expect(stdout).toBe('{"success":true}\n')
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    },
    5_000
  )
})
