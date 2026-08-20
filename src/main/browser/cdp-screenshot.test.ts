import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  captureFullPageScreenshot,
  captureScreenshot,
  captureViewportScreenshot
} from './cdp-screenshot'

function createMockWebContents() {
  return {
    isDestroyed: vi.fn(() => false),
    invalidate: vi.fn(),
    capturePage: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => true),
      sendCommand: vi.fn()
    }
  }
}

function createNativeImage(data: string, width = 400, height = 300) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    crop: vi.fn(),
    toPNG: () => Buffer.from(data),
    toJPEG: vi.fn(() => Buffer.from(data))
  }
}

describe('captureViewportScreenshot', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('prefers Electron native capture for a painted viewport', async () => {
    const webContents = createMockWebContents()
    webContents.capturePage.mockResolvedValueOnce(createNativeImage('native-png'))

    await expect(
      captureViewportScreenshot(webContents as never, { format: 'png' })
    ).resolves.toEqual({ data: Buffer.from('native-png').toString('base64') })

    expect(webContents.invalidate).toHaveBeenCalledTimes(1)
    expect(webContents.capturePage).toHaveBeenCalledTimes(1)
    expect(webContents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('falls back to guarded CDP capture when native capture stalls', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.capturePage.mockImplementation(() => new Promise(() => {}))
    webContents.debugger.sendCommand.mockResolvedValueOnce({ data: 'cdp-png' })

    const screenshot = captureViewportScreenshot(webContents as never, { format: 'png' })
    await vi.advanceTimersByTimeAsync(3000)

    await expect(screenshot).resolves.toEqual({ data: 'cdp-png' })
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png'
    })
  })

  it('crops a native image when the clip is inside the painted viewport', async () => {
    const croppedImage = createNativeImage('cropped-png', 60, 80)
    const nativeImage = createNativeImage('full-png')
    nativeImage.crop.mockReturnValueOnce(croppedImage)
    const webContents = createMockWebContents()
    webContents.capturePage.mockResolvedValueOnce(nativeImage)

    await expect(
      captureViewportScreenshot(webContents as never, {
        format: 'png',
        clip: { x: 10, y: 20, width: 30, height: 40, scale: 2 }
      })
    ).resolves.toEqual({ data: Buffer.from('cropped-png').toString('base64') })

    expect(nativeImage.crop).toHaveBeenCalledWith({ x: 20, y: 40, width: 60, height: 80 })
  })

  it('skips native capture when the request needs beyond-viewport pixels', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockResolvedValueOnce({ data: 'full-cdp-png' })

    await expect(
      captureViewportScreenshot(webContents as never, {
        format: 'png',
        captureBeyondViewport: true
      })
    ).resolves.toEqual({ data: 'full-cdp-png' })

    expect(webContents.capturePage).not.toHaveBeenCalled()
    expect(webContents.debugger.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true
    })
  })

  it('preserves zero JPEG quality on native capture', async () => {
    const nativeImage = createNativeImage('native-jpeg')
    const webContents = createMockWebContents()
    webContents.capturePage.mockResolvedValueOnce(nativeImage)

    await captureViewportScreenshot(webContents as never, { format: 'jpeg', quality: 0 })

    expect(nativeImage.toJPEG).toHaveBeenCalledWith(0)
  })

  it('falls back to CDP when native capture returns an empty image', async () => {
    const webContents = createMockWebContents()
    webContents.capturePage.mockResolvedValueOnce({ isEmpty: () => true })
    webContents.debugger.sendCommand.mockResolvedValueOnce({ data: 'cdp-after-empty' })

    await expect(captureViewportScreenshot(webContents as never)).resolves.toEqual({
      data: 'cdp-after-empty'
    })
  })

  it('reports a bounded timeout when both native and CDP capture stall', async () => {
    vi.useFakeTimers()
    const webContents = createMockWebContents()
    webContents.capturePage.mockImplementation(() => new Promise(() => {}))
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))

    const screenshot = captureViewportScreenshot(webContents as never)
    const rejection = expect(screenshot).rejects.toThrow(
      'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'
    )
    await vi.advanceTimersByTimeAsync(11_000)
    await rejection
  })
})

describe('captureScreenshot CDP proxy adapter', () => {
  it('returns native capture through the callback contract', async () => {
    const webContents = createMockWebContents()
    webContents.capturePage.mockResolvedValueOnce(createNativeImage('proxy-native'))
    const onResult = vi.fn()
    const onError = vi.fn()

    captureScreenshot(webContents as never, { format: 'png' }, onResult, onError)
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled())

    expect(onResult).toHaveBeenCalledWith({
      data: Buffer.from('proxy-native').toString('base64')
    })
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('captureFullPageScreenshot', () => {
  it('uses cssContentSize so HiDPI pages are captured at the real page size', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation((method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return Promise.resolve({
          cssContentSize: { width: 640.25, height: 1280.75 },
          contentSize: { width: 1280.5, height: 2561.5 }
        })
      }
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve({ data: 'full-page-data' })
      }
      return Promise.resolve({})
    })

    await expect(captureFullPageScreenshot(webContents as never, 'png')).resolves.toEqual({
      data: 'full-page-data',
      format: 'png'
    })
    expect(webContents.debugger.sendCommand).toHaveBeenNthCalledWith(1, 'Page.getLayoutMetrics', {})
    expect(webContents.debugger.sendCommand).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 641, height: 1281, scale: 1 }
    })
  })

  it('falls back to legacy contentSize when cssContentSize is unavailable', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation((method: string) => {
      if (method === 'Page.getLayoutMetrics') {
        return Promise.resolve({
          contentSize: { width: 800, height: 1600 }
        })
      }
      if (method === 'Page.captureScreenshot') {
        return Promise.resolve({ data: 'legacy-full-page-data' })
      }
      return Promise.resolve({})
    })

    await expect(captureFullPageScreenshot(webContents as never, 'jpeg')).resolves.toEqual({
      data: 'legacy-full-page-data',
      format: 'jpeg'
    })
    expect(webContents.debugger.sendCommand).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', {
      format: 'jpeg',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 800, height: 1600, scale: 1 }
    })
  })
})
