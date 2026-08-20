import type { WebContents } from 'electron'
import type {
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserConsoleEntry,
  BrowserConsoleResult,
  BrowserNetworkEntry,
  BrowserNetworkLogResult
} from '../../shared/runtime-types'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'

const CAPTURE_LOG_LIMIT = 1000
const DEFAULT_READ_LIMIT = 100

type DebuggerListener = (...args: unknown[]) => void

type CaptureBinding = {
  webContents: WebContents
  lease: ElectronDebuggerLease
  messageListener: DebuggerListener
  detachListener: DebuggerListener
}

type CaptureState = {
  capturing: boolean
  consoleEntries: BrowserConsoleEntry[]
  consoleEvicted: boolean
  networkEntries: BrowserNetworkEntry[]
  networkEvicted: boolean
  networkEntriesByRequestId: Map<string, BrowserNetworkEntry>
  requestMethods: Map<string, string>
  binding: CaptureBinding | null
}

type ConsoleApiParams = {
  type?: string
  args?: {
    value?: unknown
    description?: string
    unserializableValue?: string
  }[]
  timestamp?: number
  stackTrace?: { callFrames?: { url?: string; lineNumber?: number }[] }
}

type NetworkRequestParams = {
  requestId?: string
  request?: { method?: string }
}

type NetworkResponseParams = {
  requestId?: string
  response?: {
    url?: string
    status?: number
    mimeType?: string
  }
  timestamp?: number
}

type NetworkFinishedParams = {
  requestId?: string
  encodedDataLength?: number
}

function createCaptureState(): CaptureState {
  return {
    capturing: false,
    consoleEntries: [],
    consoleEvicted: false,
    networkEntries: [],
    networkEvicted: false,
    networkEntriesByRequestId: new Map(),
    requestMethods: new Map(),
    binding: null
  }
}

function normalizeReadLimit(limit?: number): number {
  return Number.isSafeInteger(limit) && (limit ?? 0) > 0 ? (limit as number) : DEFAULT_READ_LIMIT
}

function renderConsoleArgument(argument: NonNullable<ConsoleApiParams['args']>[number]): string {
  if (argument.value !== undefined) {
    if (typeof argument.value === 'string') {
      return argument.value
    }
    try {
      return JSON.stringify(argument.value) ?? String(argument.value)
    } catch {
      return String(argument.value)
    }
  }
  return argument.unserializableValue ?? argument.description ?? ''
}

export class BrowserTelemetryCapture {
  private readonly states = new Map<string, CaptureState>()

  async start(browserPageId: string, webContents: WebContents): Promise<BrowserCaptureStartResult> {
    const state = this.getOrCreateState(browserPageId)
    this.detachBinding(state)
    state.consoleEntries = []
    state.consoleEvicted = false
    state.networkEntries = []
    state.networkEvicted = false
    state.networkEntriesByRequestId.clear()
    state.requestMethods.clear()
    state.capturing = true

    try {
      await this.attachBinding(browserPageId, state, webContents)
    } catch (error) {
      state.capturing = false
      this.detachBinding(state)
      throw error
    }
    return { capturing: true }
  }

  stop(browserPageId: string): BrowserCaptureStopResult {
    const state = this.states.get(browserPageId)
    if (state) {
      state.capturing = false
      state.networkEntriesByRequestId.clear()
      state.requestMethods.clear()
      this.detachBinding(state)
    }
    return { stopped: true }
  }

  consoleLog(browserPageId: string, limit?: number): BrowserConsoleResult {
    const state = this.states.get(browserPageId)
    if (!state) {
      return { entries: [], truncated: false }
    }
    const readLimit = normalizeReadLimit(limit)
    return {
      entries: state.consoleEntries.slice(-readLimit),
      truncated: state.consoleEvicted || state.consoleEntries.length > readLimit
    }
  }

  networkLog(browserPageId: string, limit?: number): BrowserNetworkLogResult {
    const state = this.states.get(browserPageId)
    if (!state) {
      return { entries: [], truncated: false }
    }
    const readLimit = normalizeReadLimit(limit)
    return {
      entries: state.networkEntries.slice(-readLimit),
      truncated: state.networkEvicted || state.networkEntries.length > readLimit
    }
  }

  async rebind(browserPageId: string, webContents: WebContents): Promise<void> {
    const state = this.states.get(browserPageId)
    if (!state?.capturing) {
      return
    }
    this.detachBinding(state)
    try {
      await this.attachBinding(browserPageId, state, webContents)
    } catch {
      state.capturing = false
      this.detachBinding(state)
    }
  }

  remove(browserPageId: string): void {
    const state = this.states.get(browserPageId)
    if (!state) {
      return
    }
    state.capturing = false
    this.detachBinding(state)
    this.states.delete(browserPageId)
  }

  dispose(): void {
    for (const state of this.states.values()) {
      state.capturing = false
      this.detachBinding(state)
    }
    this.states.clear()
  }

  private getOrCreateState(browserPageId: string): CaptureState {
    const existing = this.states.get(browserPageId)
    if (existing) {
      return existing
    }
    const state = createCaptureState()
    this.states.set(browserPageId, state)
    return state
  }

  private async attachBinding(
    browserPageId: string,
    state: CaptureState,
    webContents: WebContents
  ): Promise<void> {
    const lease = acquireElectronDebugger(webContents)
    const messageListener: DebuggerListener = (_event, method, params) => {
      this.handleDebuggerMessage(state, method, params)
    }
    const detachListener: DebuggerListener = () => {
      const current = this.states.get(browserPageId)
      if (current !== state || current.binding?.webContents !== webContents) {
        return
      }
      current.capturing = false
      this.detachBinding(current)
    }
    state.binding = { webContents, lease, messageListener, detachListener }
    webContents.debugger.on('message', messageListener as never)
    webContents.debugger.on('detach', detachListener as never)

    await webContents.debugger.sendCommand('Runtime.enable', {})
    await webContents.debugger.sendCommand('Network.enable', {})
  }

  private detachBinding(state: CaptureState): void {
    const binding = state.binding
    if (!binding) {
      return
    }
    state.binding = null
    binding.webContents.debugger.removeListener('message', binding.messageListener as never)
    binding.webContents.debugger.removeListener('detach', binding.detachListener as never)
    binding.lease.release()
  }

  private handleDebuggerMessage(state: CaptureState, method: unknown, params: unknown): void {
    if (!state.capturing || typeof method !== 'string') {
      return
    }
    if (method === 'Runtime.consoleAPICalled') {
      this.recordConsoleEntry(state, params as ConsoleApiParams)
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const request = params as NetworkRequestParams
      if (request.requestId) {
        state.requestMethods.set(request.requestId, request.request?.method ?? '')
      }
      return
    }
    if (method === 'Network.responseReceived') {
      this.recordNetworkEntry(state, params as NetworkResponseParams)
      return
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.finishNetworkEntry(state, method, params as NetworkFinishedParams)
    }
  }

  private recordConsoleEntry(state: CaptureState, params: ConsoleApiParams): void {
    const frame = params.stackTrace?.callFrames?.[0]
    state.consoleEntries.push({
      level: params.type ?? 'log',
      text: (params.args ?? []).map(renderConsoleArgument).join(' '),
      timestamp: params.timestamp ?? Date.now(),
      url: frame?.url,
      line: frame?.lineNumber
    })
    if (state.consoleEntries.length > CAPTURE_LOG_LIMIT) {
      state.consoleEntries.shift()
      state.consoleEvicted = true
    }
  }

  private recordNetworkEntry(state: CaptureState, params: NetworkResponseParams): void {
    if (!params.response) {
      return
    }
    const entry: BrowserNetworkEntry = {
      url: params.response.url ?? '',
      method: params.requestId ? (state.requestMethods.get(params.requestId) ?? '') : '',
      status: params.response.status ?? 0,
      mimeType: params.response.mimeType ?? '',
      size: 0,
      timestamp: params.timestamp ?? Date.now()
    }
    state.networkEntries.push(entry)
    if (params.requestId) {
      state.networkEntriesByRequestId.set(params.requestId, entry)
    }
    if (state.networkEntries.length > CAPTURE_LOG_LIMIT) {
      const evicted = state.networkEntries.shift()
      state.networkEvicted = true
      if (evicted) {
        for (const [requestId, requestEntry] of state.networkEntriesByRequestId) {
          if (requestEntry === evicted) {
            state.networkEntriesByRequestId.delete(requestId)
            state.requestMethods.delete(requestId)
            break
          }
        }
      }
    }
  }

  private finishNetworkEntry(
    state: CaptureState,
    method: string,
    params: NetworkFinishedParams
  ): void {
    if (!params.requestId) {
      return
    }
    const entry = state.networkEntriesByRequestId.get(params.requestId)
    if (entry && method === 'Network.loadingFinished' && params.encodedDataLength != null) {
      entry.size = params.encodedDataLength
    }
    state.networkEntriesByRequestId.delete(params.requestId)
    state.requestMethods.delete(params.requestId)
  }
}
