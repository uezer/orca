import type { WebContents } from 'electron'

const SCREENSHOT_TIMEOUT_MS = 8000
const NATIVE_CAPTURE_TIMEOUT_MS = 3000
const SCREENSHOT_TIMEOUT_MESSAGE =
  'Screenshot timed out — the browser tab may not be visible or the window may not have focus.'

function applyFallbackClip(
  image: Electron.NativeImage,
  params: Record<string, unknown> | undefined
): Electron.NativeImage | null {
  if (params?.captureBeyondViewport) {
    // Why: capturePage() can only see the currently painted viewport. If the
    // caller asked for beyond-viewport pixels, returning a viewport-sized image
    // would silently lie about what was captured.
    return null
  }

  const clip = params?.clip
  if (!clip || typeof clip !== 'object') {
    return image
  }
  const clipRect = clip as Record<string, unknown>

  const x = typeof clipRect.x === 'number' ? clipRect.x : Number.NaN
  const y = typeof clipRect.y === 'number' ? clipRect.y : Number.NaN
  const width = typeof clipRect.width === 'number' ? clipRect.width : Number.NaN
  const height = typeof clipRect.height === 'number' ? clipRect.height : Number.NaN
  const scale =
    typeof clipRect.scale === 'number' && Number.isFinite(clipRect.scale) && clipRect.scale > 0
      ? clipRect.scale
      : 1

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null
  }

  const cropRect = {
    x: Math.round(x * scale),
    y: Math.round(y * scale),
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  }
  const imageSize = image.getSize()
  if (
    cropRect.x < 0 ||
    cropRect.y < 0 ||
    cropRect.width <= 0 ||
    cropRect.height <= 0 ||
    cropRect.x + cropRect.width > imageSize.width ||
    cropRect.y + cropRect.height > imageSize.height
  ) {
    return null
  }

  return image.crop(cropRect)
}

function encodeNativeImageScreenshot(
  image: Electron.NativeImage,
  params: Record<string, unknown> | undefined
): { data: string } | null {
  if (image.isEmpty()) {
    return null
  }

  const clippedImage = applyFallbackClip(image, params)
  if (!clippedImage || clippedImage.isEmpty()) {
    return null
  }

  const format = params?.format === 'jpeg' ? 'jpeg' : 'png'
  const quality =
    typeof params?.quality === 'number' && Number.isFinite(params.quality)
      ? Math.max(0, Math.min(100, Math.round(params.quality)))
      : undefined
  const buffer = format === 'jpeg' ? clippedImage.toJPEG(quality ?? 90) : clippedImage.toPNG()
  return { data: buffer.toString('base64') }
}

function getLayoutClip(metrics: {
  cssContentSize?: { width?: number; height?: number }
  contentSize?: { width?: number; height?: number }
}): { x: number; y: number; width: number; height: number; scale: number } | null {
  // Why: Page.captureScreenshot clip coordinates are in CSS pixels. On HiDPI
  // Electron guests, `contentSize` can reflect device pixels, which makes
  // Chromium tile the page into a duplicated 2x2 grid. Prefer cssContentSize
  // and only fall back to contentSize when older Chromium builds omit it.
  const size = metrics.cssContentSize ?? metrics.contentSize
  const width = size?.width
  const height = size?.height
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null
  }

  return {
    x: 0,
    y: 0,
    width: Math.ceil(width),
    height: Math.ceil(height),
    scale: 1
  }
}

async function sendCommandWithTimeout<T>(
  webContents: WebContents,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMessage: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      webContents.debugger.sendCommand(method, params ?? {}) as Promise<T>,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), SCREENSHOT_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function captureNativeViewport(
  webContents: WebContents,
  params: Record<string, unknown> | undefined
): Promise<{ data: string } | null> {
  let timer: NodeJS.Timeout | null = null
  try {
    const image = await Promise.race([
      Promise.resolve().then(() => webContents.capturePage()),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), NATIVE_CAPTURE_TIMEOUT_MS)
      })
    ])
    return image ? encodeNativeImageScreenshot(image, params) : null
  } catch {
    return null
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function screenshotCommandParams(
  params: Record<string, unknown> | undefined
): Record<string, unknown> {
  const commandParams: Record<string, unknown> = {}
  for (const key of ['format', 'quality', 'clip', 'captureBeyondViewport', 'fromSurface']) {
    if (params?.[key] != null) {
      commandParams[key] = params[key]
    }
  }
  return commandParams
}

export async function captureViewportScreenshot(
  webContents: WebContents,
  params?: Record<string, unknown>
): Promise<{ data: string }> {
  if (webContents.isDestroyed()) {
    throw new Error('WebContents destroyed')
  }

  try {
    webContents.invalidate()
  } catch {
    // Guest teardown can reject repaint requests; the capture paths report the real failure.
  }

  // Why: Electron's native capture avoids the CDP compositor deadlock seen on WebGL guests.
  if (!params?.captureBeyondViewport) {
    const nativeResult = await captureNativeViewport(webContents, params)
    if (nativeResult) {
      return nativeResult
    }
  }

  const dbg = webContents.debugger
  if (!dbg.isAttached()) {
    throw new Error('Debugger not attached')
  }
  return sendCommandWithTimeout<{ data: string }>(
    webContents,
    'Page.captureScreenshot',
    screenshotCommandParams(params),
    SCREENSHOT_TIMEOUT_MESSAGE
  )
}

export async function captureFullPageScreenshot(
  webContents: WebContents,
  format: 'png' | 'jpeg' = 'png'
): Promise<{ data: string; format: 'png' | 'jpeg' }> {
  if (webContents.isDestroyed()) {
    throw new Error('WebContents destroyed')
  }
  const dbg = webContents.debugger
  if (!dbg.isAttached()) {
    throw new Error('Debugger not attached')
  }

  try {
    webContents.invalidate()
  } catch {
    // Some guest teardown paths reject repaint requests. Fall through to CDP.
  }

  const metrics = await sendCommandWithTimeout<{
    cssContentSize?: { width?: number; height?: number }
    contentSize?: { width?: number; height?: number }
  }>(webContents, 'Page.getLayoutMetrics', undefined, SCREENSHOT_TIMEOUT_MESSAGE)
  const clip = getLayoutClip(metrics)
  if (!clip) {
    throw new Error('Unable to determine full-page screenshot bounds')
  }

  const { data } = await sendCommandWithTimeout<{ data: string }>(
    webContents,
    'Page.captureScreenshot',
    {
      format,
      captureBeyondViewport: true,
      clip
    },
    SCREENSHOT_TIMEOUT_MESSAGE
  )

  return { data, format }
}

export function captureScreenshot(
  webContents: WebContents,
  params: Record<string, unknown> | undefined,
  onResult: (result: unknown) => void,
  onError: (message: string) => void
): void {
  void captureViewportScreenshot(webContents, params).then(onResult, (error: unknown) => {
    onError(error instanceof Error ? error.message : String(error))
  })
}
