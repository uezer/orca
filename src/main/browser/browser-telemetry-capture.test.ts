import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserTelemetryCapture } from './browser-telemetry-capture'

function createWebContents(initiallyAttached = false) {
  const emitter = new EventEmitter()
  let attached = initiallyAttached
  const debuggerApi = {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
      emitter.emit('detach')
    }),
    sendCommand: vi.fn(async () => ({})),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener)
    }),
    removeListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      emitter.removeListener(event, listener)
    })
  }
  const webContents = {
    isDestroyed: vi.fn(() => false),
    debugger: debuggerApi
  } as unknown as WebContents

  return {
    webContents,
    debuggerApi,
    emit(method: string, params: unknown) {
      emitter.emit('message', {}, method, params)
    },
    detachExternally() {
      attached = false
      emitter.emit('detach')
    },
    listenerCount(event: string) {
      return emitter.listenerCount(event)
    }
  }
}

describe('BrowserTelemetryCapture', () => {
  let capture: BrowserTelemetryCapture

  beforeEach(() => {
    capture = new BrowserTelemetryCapture()
  })

  it('captures console and network entries and retains them after stop', async () => {
    const target = createWebContents()
    await expect(capture.start('page-1', target.webContents)).resolves.toEqual({ capturing: true })

    target.emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ value: 'failed' }, { description: 'Error: probe' }],
      timestamp: 10
    })
    target.emit('Network.requestWillBeSent', {
      requestId: 'request-1',
      request: { method: 'PATCH' }
    })
    target.emit('Network.responseReceived', {
      requestId: 'request-1',
      response: { url: 'https://example.com/api', status: 204, mimeType: 'text/plain' },
      timestamp: 20
    })
    target.emit('Network.loadingFinished', {
      requestId: 'request-1',
      encodedDataLength: 128
    })

    expect(capture.consoleLog('page-1')).toEqual({
      entries: [{ level: 'error', text: 'failed Error: probe', timestamp: 10 }],
      truncated: false
    })
    expect(capture.networkLog('page-1')).toEqual({
      entries: [
        {
          url: 'https://example.com/api',
          method: 'PATCH',
          status: 204,
          mimeType: 'text/plain',
          size: 128,
          timestamp: 20
        }
      ],
      truncated: false
    })

    expect(capture.stop('page-1')).toEqual({ stopped: true })
    target.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'ignored' }],
      timestamp: 30
    })
    expect(capture.consoleLog('page-1').entries).toHaveLength(1)
    expect(target.listenerCount('message')).toBe(0)
    expect(target.debuggerApi.detach).toHaveBeenCalledTimes(1)
  })

  it('caps retained entries and reports both eviction and read-limit truncation', async () => {
    const target = createWebContents(true)
    await capture.start('page-1', target.webContents)

    for (let index = 0; index <= 1000; index++) {
      target.emit('Runtime.consoleAPICalled', {
        args: [{ value: `entry-${index}` }],
        timestamp: index
      })
    }

    const allRetained = capture.consoleLog('page-1', 1000)
    expect(allRetained.entries).toHaveLength(1000)
    expect(allRetained.entries[0]?.text).toBe('entry-1')
    expect(allRetained.truncated).toBe(true)
    expect(capture.consoleLog('page-1', 2)).toMatchObject({
      entries: [{ text: 'entry-999' }, { text: 'entry-1000' }],
      truncated: true
    })
  })

  it('rebinds an active capture after a renderer process swap', async () => {
    const first = createWebContents()
    const replacement = createWebContents()
    await capture.start('page-1', first.webContents)
    first.emit('Runtime.consoleAPICalled', { args: [{ value: 'before' }], timestamp: 1 })

    await capture.rebind('page-1', replacement.webContents)
    first.emit('Runtime.consoleAPICalled', { args: [{ value: 'stale' }], timestamp: 2 })
    replacement.emit('Runtime.consoleAPICalled', { args: [{ value: 'after' }], timestamp: 3 })

    expect(capture.consoleLog('page-1').entries.map((entry) => entry.text)).toEqual([
      'before',
      'after'
    ])
    expect(first.listenerCount('message')).toBe(0)
    expect(replacement.listenerCount('message')).toBe(1)
    expect(first.debuggerApi.detach).toHaveBeenCalledTimes(1)
  })

  it('cleans up listeners and debugger ownership when capture setup fails', async () => {
    const target = createWebContents()
    target.debuggerApi.sendCommand
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Network domain unavailable'))

    await expect(capture.start('page-1', target.webContents)).rejects.toThrow(
      'Network domain unavailable'
    )
    expect(target.listenerCount('message')).toBe(0)
    expect(target.listenerCount('detach')).toBe(0)
    expect(target.debuggerApi.detach).toHaveBeenCalledTimes(1)
    expect(capture.consoleLog('page-1')).toEqual({ entries: [], truncated: false })
  })

  it('stops capture when Electron detaches the debugger', async () => {
    const target = createWebContents(true)
    await capture.start('page-1', target.webContents)
    target.emit('Runtime.consoleAPICalled', { args: [{ value: 'before' }], timestamp: 1 })

    target.detachExternally()
    target.emit('Runtime.consoleAPICalled', { args: [{ value: 'after' }], timestamp: 2 })

    expect(capture.consoleLog('page-1').entries.map((entry) => entry.text)).toEqual(['before'])
    expect(target.listenerCount('message')).toBe(0)
    expect(target.listenerCount('detach')).toBe(0)
  })
})
