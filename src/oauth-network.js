import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'

import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket from 'ws'

const execFileAsync = promisify(execFile)
const CODEX_AUTH_HOST = 'auth.openai.com'
const CODEX_SUBSCRIPTION_HOST = 'chatgpt.com'
const CODEX_HOSTS = new Set([CODEX_AUTH_HOST, CODEX_SUBSCRIPTION_HOST])
const CODEX_ORIGINATOR = 'codex_cli_rs'
const CODEX_COMPAT_VERSION = '0.155.1'
const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/${CODEX_COMPAT_VERSION}`
const CODEX_INSTALLATION_ID = randomUUID()

const networkScope = new AsyncLocalStorage()
let activeScopes = 0
let baseFetch
let scopedFetch
let baseWebSocket
let scopedWebSocket
let activeWebSocketScopes = 0

function headerRecord(headers) {
  if (headers === undefined || headers === null) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  return { ...headers }
}

function officialCodexHeaders(headers) {
  const next = headerRecord(headers)
  next.originator = CODEX_ORIGINATOR
  next['User-Agent'] = CODEX_USER_AGENT
  return next
}

function diagnosticText(data) {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return undefined
}

function safeModelEvent(data) {
  try {
    const text = diagnosticText(data)
    if (text === undefined) return undefined
    const event = JSON.parse(text)
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return undefined
    const response = event.response
    return {
      type: event.type,
      ...(['error', 'response.failed'].includes(event.type) ? { failed: true } : {}),
      ...(response && typeof response === 'object' && typeof response.model === 'string' ? { model: response.model } : {}),
      ...(response && typeof response === 'object' && typeof response.service_tier === 'string' ? { serviceTier: response.service_tier } : {}),
      ...(response && typeof response === 'object' && Number.isSafeInteger(response.usage?.output_tokens) ? { outputTokens: response.usage.output_tokens } : {}),
      ...(Number.isSafeInteger(response?.usage?.output_tokens_details?.reasoning_tokens) ? { reasoningTokens: response.usage.output_tokens_details.reasoning_tokens } : {}),
    }
  } catch {
    return undefined
  }
}

function normalizeProxy(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const value = raw.trim().includes('://') ? raw.trim() : `http://${raw.trim()}`
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '') return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function bypassesProxy(hostname, port, rawNoProxy) {
  if (typeof rawNoProxy !== 'string' || rawNoProxy.trim() === '') return false
  return rawNoProxy.split(/[\s,]+/u).some(raw => {
    const entry = raw.trim().toLowerCase()
    if (entry === '*') return true
    if (entry === '') return false
    const match = /^(.*?)(?::(\d+))?$/u.exec(entry)
    const host = match?.[1]?.replace(/^\./u, '')
    const entryPort = match?.[2]
    if (!host || (entryPort && entryPort !== port)) return false
    return hostname === host || hostname.endsWith(`.${host}`)
  })
}

export function proxyFromEnvironment(env = process.env, target = new URL(`https://${CODEX_AUTH_HOST}/`)) {
  if (bypassesProxy(target.hostname.toLowerCase(), target.port || '443', env.NO_PROXY ?? env.no_proxy)) return undefined
  return normalizeProxy(env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy)
}

function selectWindowsProxy(value) {
  if (typeof value !== 'string') return undefined
  const entries = value.split(';').map(item => item.trim()).filter(Boolean)
  const https = entries.find(item => /^https=/iu.test(item))
  const http = entries.find(item => /^http=/iu.test(item))
  const selected = (https ?? http ?? entries.find(item => !item.includes('=')))?.replace(/^[^=]+=/u, '')
  return normalizeProxy(selected)
}

async function windowsSystemProxy(options = {}) {
  const run = options.execFile ?? execFileAsync
  const reg = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\reg.exe`
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  try {
    const enabled = await run(reg, ['query', key, '/v', 'ProxyEnable'], { windowsHide: true, encoding: 'utf8' })
    if (!/REG_DWORD\s+0x1\b/iu.test(enabled.stdout)) return undefined
    const configured = await run(reg, ['query', key, '/v', 'ProxyServer'], { windowsHide: true, encoding: 'utf8' })
    const match = /^\s*ProxyServer\s+REG_\w+\s+(.+)$/imu.exec(configured.stdout)
    return selectWindowsProxy(match?.[1])
  } catch {
    return undefined
  }
}

async function macSystemProxy(options = {}) {
  const run = options.execFile ?? execFileAsync
  try {
    const result = await run('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' })
    if (!/^\s*HTTPSEnable\s*:\s*1\s*$/imu.test(result.stdout)) return undefined
    const host = /^\s*HTTPSProxy\s*:\s*(\S+)\s*$/imu.exec(result.stdout)?.[1]
    const port = /^\s*HTTPSPort\s*:\s*(\d+)\s*$/imu.exec(result.stdout)?.[1]
    return normalizeProxy(host && port ? `${host}:${port}` : undefined)
  } catch {
    return undefined
  }
}

export async function resolveCodexOAuthProxy(options = {}) {
  return (await resolveCodexProxy(options)).url
}

async function resolveCodexProxy(options = {}) {
  const target = options.target ?? new URL(`https://${CODEX_AUTH_HOST}/`)
  const env = options.env ?? process.env
  if (bypassesProxy(target.hostname.toLowerCase(), target.port || '443', env.NO_PROXY ?? env.no_proxy)) {
    return { url: undefined, source: 'bypass' }
  }
  const envProxy = proxyFromEnvironment(env, target)
  if (envProxy) return { url: envProxy, source: 'environment' }
  const platform = options.platform ?? process.platform
  const system = platform === 'win32'
    ? await windowsSystemProxy(options)
    : platform === 'darwin'
      ? await macSystemProxy(options)
      : undefined
  return system ? { url: system, source: 'system' } : { url: undefined, source: 'direct' }
}

function bodyBytes(body) {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof URLSearchParams) return Buffer.from(body.toString())
  if (body instanceof Uint8Array) return Buffer.from(body)
  throw new TypeError('Unsupported Codex OAuth request body')
}

export function fetchThroughProxy(input, init, proxyUrl) {
  const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const body = bodyBytes(init?.body)
  const headers = new Headers(init?.headers)
  if (body && !headers.has('content-length')) headers.set('content-length', String(body.byteLength))
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, {
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(headers.entries()),
      agent: new HttpsProxyAgent(proxyUrl),
      signal: init?.signal,
    }, response => {
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item))
        else if (value !== undefined) responseHeaders.set(name, value)
      }
      const status = response.statusCode ?? 500
      const empty = init?.method === 'HEAD' || [204, 205, 304].includes(status)
      resolve(new Response(empty ? null : Readable.toWeb(response), {
        status,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }))
    })
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

function createScopedWebSocketConstructor(WebSocketImpl = WebSocket) {
  return class CodexScopedWebSocket extends WebSocketImpl {
    constructor(url, protocolsOrOptions) {
      const target = new URL(url.toString())
      const scope = networkScope.getStore()
      const route = scope?.webSocketRoute
      const isCodex = target.hostname === CODEX_SUBSCRIPTION_HOST

      let protocols
      let webSocketOptions = {}
      if (typeof protocolsOrOptions === 'string' || Array.isArray(protocolsOrOptions)) {
        protocols = protocolsOrOptions
      } else if (protocolsOrOptions && typeof protocolsOrOptions === 'object') {
        webSocketOptions = { ...protocolsOrOptions }
      }

      if (isCodex) {
        webSocketOptions.headers = officialCodexHeaders(webSocketOptions.headers)
        if (route?.url) webSocketOptions.agent = new HttpsProxyAgent(route.url)
      }

      if (protocols === undefined) super(url, webSocketOptions)
      else super(url, protocols, webSocketOptions)

      this.codexSessionId = isCodex
        ? String(webSocketOptions.headers?.['session-id'] ?? webSocketOptions.headers?.['Session-Id'] ?? randomUUID())
        : undefined
      this.codexThreadId = this.codexSessionId
      this.codexWindowId = this.codexSessionId === undefined ? undefined : `${this.codexThreadId}:0`

      if (isCodex && typeof this.addEventListener === 'function') {
        this.addEventListener('message', event => {
          const info = safeModelEvent(event?.data)
          if (info !== undefined) this.codexRequestScope?.options?.onModelEvent?.(info)
        })
      }
    }

    send(...args) {
      const scope = networkScope.getStore()
      if (new URL(this.url).hostname !== CODEX_SUBSCRIPTION_HOST) return super.send(...args)

      this.codexRequestScope = scope
      scope?.options?.onTransport?.('websocket')
      const raw = diagnosticText(args[0])
      if (raw === undefined) return super.send(...args)

      try {
        const request = JSON.parse(raw)
        if (request?.type !== 'response.create') return super.send(...args)
        const turnId = randomUUID()
        const turnMetadata = {
          installation_id: CODEX_INSTALLATION_ID,
          session_id: this.codexSessionId,
          thread_id: this.codexThreadId,
          turn_id: turnId,
          window_id: this.codexWindowId,
          request_kind: 'turn',
          turn_started_at_unix_ms: Date.now(),
        }
        request.client_metadata = {
          ...(request.client_metadata && typeof request.client_metadata === 'object' ? request.client_metadata : {}),
          'x-codex-installation-id': CODEX_INSTALLATION_ID,
          session_id: this.codexSessionId,
          thread_id: this.codexThreadId,
          'x-codex-window-id': this.codexWindowId,
          turn_id: turnId,
          'x-codex-turn-metadata': JSON.stringify(turnMetadata),
        }
        scope?.options?.onModelRequest?.({
          model: typeof request.model === 'string' ? request.model : undefined,
          serviceTier: typeof request.service_tier === 'string' ? request.service_tier : undefined,
          reasoningEffort: request.reasoning?.effort,
          responsesLite: request.client_metadata?.ws_request_header_x_openai_internal_codex_responses_lite === 'true',
          continuation: typeof request.previous_response_id === 'string',
          clientIdentity: CODEX_ORIGINATOR,
        })
        return super.send(JSON.stringify(request), ...args.slice(1))
      } catch {
        return super.send(...args)
      }
    }
  }
}

export async function withCodexNetwork(run, options = {}) {
  if (activeScopes === 0) {
    baseFetch = globalThis.fetch
    scopedFetch = async (input, init) => {
      const scope = networkScope.getStore()
      if (scope === undefined) return baseFetch(input, init)
      const { options: scopedOptions, allowedHosts, resolved } = scope
      const proxyFetch = scopedOptions.fetchThroughProxy ?? fetchThroughProxy
      const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (target.protocol !== 'https:' || !allowedHosts.has(target.hostname)) return baseFetch(input, init)
      let nextInit = init
      if (target.hostname === CODEX_SUBSCRIPTION_HOST && target.pathname === '/backend-api/codex/responses') {
        scopedOptions.onTransport?.('sse')
        scopedOptions.onModelRequest?.({ clientIdentity: CODEX_ORIGINATOR })
        nextInit = { ...init, headers: officialCodexHeaders(init?.headers) }
      }
      let proxy = resolved.get(target.hostname)
      if (proxy === undefined) {
        proxy = resolveCodexProxy({ ...scopedOptions, target })
        resolved.set(target.hostname, proxy)
      }
      const route = await proxy
      scopedOptions.onRoute?.(route.source)
      return route.url === undefined ? baseFetch(input, nextInit) : proxyFetch(input, nextInit, route.url)
    }
    globalThis.fetch = scopedFetch
  }
  activeScopes += 1

  const scope = {
    options,
    allowedHosts: options.hosts ?? CODEX_HOSTS,
    resolved: new Map(),
    webSocketRoute: undefined,
  }

  const enableWebSocket = options.webSocket === true
  if (enableWebSocket) {
    const target = new URL(`https://${CODEX_SUBSCRIPTION_HOST}/backend-api/codex/responses`)
    scope.webSocketRoute = await resolveCodexProxy({ ...options, target })
    options.onRoute?.(scope.webSocketRoute.source)
    if (activeWebSocketScopes === 0) {
      baseWebSocket = globalThis.WebSocket
      scopedWebSocket = createScopedWebSocketConstructor(options.WebSocketImpl ?? WebSocket)
      globalThis.WebSocket = scopedWebSocket
    }
    activeWebSocketScopes += 1
  }

  try {
    return await networkScope.run(scope, run)
  } finally {
    if (enableWebSocket) {
      activeWebSocketScopes -= 1
      if (activeWebSocketScopes === 0) {
        if (globalThis.WebSocket === scopedWebSocket) globalThis.WebSocket = baseWebSocket
        baseWebSocket = undefined
        scopedWebSocket = undefined
      }
    }
    activeScopes -= 1
    if (activeScopes === 0) {
      if (globalThis.fetch === scopedFetch) globalThis.fetch = baseFetch
      baseFetch = undefined
      scopedFetch = undefined
    }
  }
}

export const withCodexOAuthNetwork = (run, options = {}) => withCodexNetwork(run, {
  ...options,
  hosts: new Set([CODEX_AUTH_HOST]),
})

function classifyTransportError(error) {
  const name = error?.name
  const code = String(error?.code ?? error?.cause?.code ?? '')
  if (name === 'AbortError' || name === 'TimeoutError' || /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/u.test(code)) return 'timeout'
  if (/ENOTFOUND|EAI_AGAIN/u.test(code)) return 'dns'
  if (/CERT_|TLS|SSL/u.test(code)) return 'tls'
  if (/ECONN|EPIPE|UND_ERR_SOCKET/u.test(code)) return 'connection'
  return 'network'
}

const elapsedBucket = elapsed => elapsed < 1_000 ? 'under-1s' : elapsed < 5_000 ? '1-5s' : elapsed < 15_000 ? '5-15s' : 'over-15s'

export function createCodexNetworkTransport(options = {}) {
  const attempts = new Map()
  const now = options.now ?? Date.now
  const run = async (area, operation) => {
    const startedAt = now()
    let route = attempts.get(area)?.route ?? 'direct'
    let transport = attempts.get(area)?.transport
    let sawWebSocket = false
    let sawSse = false
    let routed = false
    let requestedModel
    let requestedServiceTier
    let serverModel
    let serverServiceTier
    let clientIdentity
    let firstEventMs
    let firstTextMs
    let outputTokens
    let reasoningTokens, reasoningEffort, responsesLite, continuation
    let providerFailed = false
    const safeElapsed = () => Math.max(0, now() - startedAt)
    const transportFields = () => ({
      ...(transport === undefined ? {} : { transport }),
      ...(sawWebSocket && sawSse ? { fallback: 'websocket-to-sse' } : {}),
      ...(clientIdentity === undefined ? {} : { clientIdentity }),
      ...(requestedModel === undefined ? {} : { requestedModel }),
      ...(requestedServiceTier === undefined ? {} : { requestedServiceTier }),
      ...(serverModel === undefined ? {} : { serverModel }),
      ...(serverServiceTier === undefined ? {} : { serverServiceTier }),
      ...(firstEventMs === undefined ? {} : { firstEventMs }),
      ...(firstTextMs === undefined ? {} : { firstTextMs }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(responsesLite === undefined ? {} : { responsesLite }),
      ...(continuation === undefined ? {} : { continuation }),
      ...(area === 'model' ? { durationMs: safeElapsed() } : {}),
    })
    try {
      const value = await withCodexNetwork(operation, {
        ...options,
        webSocket: area === 'model',
        onRoute: source => { route = source; routed = true },
        onTransport: value => {
          if (value === 'websocket') sawWebSocket = true
          if (value === 'sse') sawSse = true
          transport = value
          options.onTransport?.(value)
        },
        onModelRequest: info => {
          if (typeof info?.clientIdentity === 'string') clientIdentity = info.clientIdentity
          if (typeof info?.model === 'string') requestedModel = info.model
          if (typeof info?.serviceTier === 'string') requestedServiceTier = info.serviceTier
          reasoningEffort = info?.reasoningEffort
          responsesLite = info?.responsesLite
          continuation = info?.continuation
          options.onModelRequest?.(info)
        },
        onModelEvent: info => {
          if (info?.failed) providerFailed = true
          const elapsed = safeElapsed()
          if (firstEventMs === undefined) firstEventMs = elapsed
          if (info?.type === 'response.output_text.delta' && firstTextMs === undefined) firstTextMs = elapsed
          if (typeof info?.model === 'string') serverModel = info.model
          if (typeof info?.serviceTier === 'string') serverServiceTier = info.serviceTier
          if (Number.isSafeInteger(info?.outputTokens) && info.outputTokens >= 0) outputTokens = info.outputTokens
          if (Number.isSafeInteger(info?.reasoningTokens)) reasoningTokens = info.reasoningTokens
          options.onModelEvent?.(info)
        },
      })
      if (value instanceof Response && !value.ok) {
        attempts.set(area, { status: 'failed', stage: 'http', code: 'http-error', httpStatus: value.status, route, elapsed: elapsedBucket(now() - startedAt), ...transportFields() })
      } else if (providerFailed) {
        attempts.set(area, { status: 'failed', stage: 'provider', code: 'provider-error', route, elapsed: elapsedBucket(now() - startedAt), ...transportFields() })
      } else if (routed || value instanceof Response) {
        attempts.set(area, { status: 'ok', route, elapsed: elapsedBucket(now() - startedAt), ...transportFields() })
      }
      return value
    } catch (error) {
      if (routed) attempts.set(area, { status: 'failed', stage: 'transport', code: classifyTransportError(error), route, elapsed: elapsedBucket(now() - startedAt), ...transportFields() })
      throw error
    }
  }
  return Object.freeze({
    run,
    fetch: (area, input, init) => run(area, () => globalThis.fetch(input, init)),
    snapshot: () => Object.fromEntries([...attempts].map(([area, value]) => [area, { ...value }])),
  })
}
