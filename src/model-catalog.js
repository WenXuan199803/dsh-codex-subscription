import { PACKAGE_VERSION, USER_AGENT } from './version.js'

export const CODEX_MODELS_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(PACKAGE_VERSION)}`

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : undefined

function reasoningMap(levels) {
  const supported = new Set((Array.isArray(levels) ? levels : [])
    .map(level => nonEmpty(record(level) ? level.effort : undefined))
    .filter(Boolean))
  const map = Object.fromEntries(LEVELS.map(level => [level, null]))
  if (supported.has('none')) map.off = 'none'
  for (const level of LEVELS.slice(1)) {
    if (supported.has(level)) map[level] = level
  }
  return map
}

const capabilityNames = values => [...new Set(values.filter(value =>
  typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/u.test(value)))].sort().slice(0, 16)

function unsupportedCapabilities(value) {
  const reasoning = capabilityNames((value.supported_reasoning_levels ?? []).map(item => item?.effort))
    .filter(level => !['none', ...LEVELS.slice(1)].includes(level))
  const inputs = capabilityNames(Array.isArray(value.input_modalities) ? value.input_modalities : [])
    .filter(input => !['text', 'image'].includes(input))
  const speeds = capabilityNames([
    ...(Array.isArray(value.additional_speed_tiers) ? value.additional_speed_tiers : []),
    ...(Array.isArray(value.service_tiers) ? value.service_tiers.map(tier => tier?.id) : []),
  ]).filter(tier => !['auto', 'default', 'standard', 'fast', 'priority'].includes(tier))
  return {
    ...(reasoning.length ? { reasoning } : {}),
    ...(inputs.length ? { inputs } : {}),
    ...(speeds.length ? { speeds } : {}),
  }
}

function visibleModel(value) {
  if (!record(value)) return undefined
  const id = nonEmpty(value.slug)
  // Reserve is a manually selected experiment, only when the account catalog
  // actually advertises it. Do not expose other hidden models or invent it offline.
  const reserve = id === 'gpt-reserve' && ['list', 'hide'].includes(value.visibility)
  if (id === undefined || (value.visibility !== 'list' && !reserve)) return undefined
  const supported = Array.isArray(value.supported_reasoning_levels) ? value.supported_reasoning_levels : []
  const input = Array.isArray(value.input_modalities)
    ? value.input_modalities.filter(item => ['text', 'image'].includes(item))
    : ['text', 'image']
  const unsupported = unsupportedCapabilities({ ...value, supported_reasoning_levels: supported })
  return {
    ...(Object.keys(unsupported).length ? { unsupported } : {}),
    id,
    name: reserve ? 'GPT-Reserve (Experimental)' : nonEmpty(value.display_name) ?? id,
    description: nonEmpty(value.description),
    priority: Number.isFinite(value.priority) ? value.priority : 0,
    input: input.length > 0 ? input : ['text'],
    contextWindow: positiveInteger(value.context_window) ?? positiveInteger(value.max_context_window),
    ...(positiveInteger(value.max_context_window) === undefined ? {} : { maxContextWindow: value.max_context_window }),
    reasoning: supported.length > 0,
    thinkingLevelMap: reasoningMap(supported),
    supportVerbosity: value.support_verbosity === true,
    defaultVerbosity: ['low', 'medium', 'high'].includes(value.default_verbosity) ? value.default_verbosity : undefined,
    ...(typeof value.use_responses_lite === 'boolean' ? { useResponsesLite: value.use_responses_lite } : {}),
    ...(typeof value.supports_reasoning_summary_parameter === 'boolean' ? { supportsReasoningSummary: value.supports_reasoning_summary_parameter } : {}),
    ...(['none', 'auto', 'concise', 'detailed'].includes(value.default_reasoning_summary) ? { defaultReasoningSummary: value.default_reasoning_summary } : {}),
    ...(nonEmpty(value.default_reasoning_level) ? { defaultReasoningEffort: value.default_reasoning_level } : {}),
    supportsFast: [...(Array.isArray(value.additional_speed_tiers) ? value.additional_speed_tiers : []),
      ...(Array.isArray(value.service_tiers) ? value.service_tiers.map(tier => tier?.id) : [])]
      .some(tier => tier === 'fast' || tier === 'priority'),
  }
}

export function parseOfficialModelCatalog(value) {
  if (!record(value) || !Array.isArray(value.models)) throw new Error('Codex returned a malformed model catalog')
  const seen = new Set()
  return value.models
    .map(visibleModel)
    .filter(model => model !== undefined && !seen.has(model.id) && seen.add(model.id))
    .sort((left, right) => Number(left.id === 'gpt-reserve') - Number(right.id === 'gpt-reserve')
      || right.priority - left.priority)
}

function mergeModel(baseModels, remote) {
  const base = baseModels.find(model => model.id === remote.id)
    ?? baseModels.find(model => model.id !== 'gpt-5.3-codex-spark')
    ?? baseModels[0]
  if (base === undefined) return undefined
  return {
    ...base,
    id: remote.id,
    name: remote.name,
    input: remote.input,
    reasoning: remote.reasoning,
    thinkingLevelMap: remote.thinkingLevelMap,
    ...(remote.contextWindow === undefined ? {} : { contextWindow: remote.contextWindow }),
    ...(remote.maxContextWindow === undefined ? {} : { maxContextWindow: remote.maxContextWindow }),
    // Subscription-backed models do not expose API billing to this plugin.
    ...(base.id === remote.id ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  }
}

export function createOfficialModelCatalog(options = {}) {
  const fetchCatalog = options.fetch ?? fetch
  const scheduleTimeout = options.setTimeout ?? setTimeout
  const cancelTimeout = options.clearTimeout ?? clearTimeout
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_REFRESH_TIMEOUT_MS
  let models
  let metadata = new Map()
  let etag
  let revision = 0
  let refreshing
  let generation = 0
  let refreshStatus = 'idle'

  const refresh = ({ signal, modelId } = {}) => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Codex model catalog refresh aborted'))
    if (refreshing?.generation === generation) return refreshing.promise
    const currentGeneration = generation
    refreshStatus = 'refreshing'
    let outcome = 'idle'
    const controller = new AbortController()
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal?.reason ?? new Error('Codex model catalog refresh aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    const requestSignal = controller.signal
    let timer
    const timeoutError = new Error('Codex model catalog refresh timed out')
    const work = (async () => {
      const request = async () => {
        const auth = await options.getAuth({ signal: requestSignal })
        const credential = await options.readCredential({ signal: requestSignal })
        const access = auth?.auth?.apiKey
        const accountId = credential?.type === 'oauth' ? credential.accountId : undefined
        if (typeof access !== 'string' || access.length === 0 || typeof accountId !== 'string' || accountId.length === 0) {
          throw new Error('Codex model catalog has no usable account credential')
        }
        const headers = {
          authorization: `Bearer ${access}`,
          'chatgpt-account-id': accountId,
          accept: 'application/json',
          originator: 'pi',
          'user-agent': USER_AGENT,
          ...(etag === undefined || modelId !== undefined ? {} : { 'if-none-match': etag }),
        }
        return fetchCatalog(CODEX_MODELS_URL, { method: 'GET', redirect: 'error', headers, signal: requestSignal })
      }
      const accountIds = options.accountIds === undefined ? undefined : await options.accountIds()
      let response
      let requiredModels
      let lastError
      for (const id of Array.isArray(accountIds) && accountIds.length > 0 ? accountIds : [undefined]) {
        requestSignal.throwIfAborted()
        try {
          response = id === undefined ? await request() : await options.withAccount(id, request)
          if (response.status === 304) break
          if (response.ok && modelId !== undefined) {
            requiredModels = parseOfficialModelCatalog(await response.clone().json())
            if (requiredModels.some(model => model.id === modelId)) break
            lastError = new Error(`Codex account does not advertise model ${modelId}`)
            response = undefined
            continue
          }
          if (response.ok) break
          lastError = new Error(`Codex model catalog failed (HTTP ${response.status})`)
          response = undefined
        } catch (error) {
          lastError = error
        }
      }
      if (response === undefined) throw lastError ?? new Error('Codex model catalog is unavailable')
      if (currentGeneration !== generation || requestSignal.aborted) return false
      if (response.status === 304) {
        outcome = 'ok'
        return false
      }
      if (!response.ok) throw new Error(`Codex model catalog failed (HTTP ${response.status})`)
      const remote = requiredModels ?? parseOfficialModelCatalog(await response.json())
      if (currentGeneration !== generation || requestSignal.aborted) return false
      if (remote.length === 0) throw new Error('Codex returned an empty model catalog')
      const baseModels = options.baseModels()
      const next = remote.map(model => mergeModel(baseModels, model)).filter(Boolean)
      if (next.length === 0) throw new Error('Codex model catalog has no compatible models')
      if (currentGeneration !== generation || requestSignal.aborted) return false
      models = next
      metadata = new Map(remote.map(model => [model.id, model]))
      etag = nonEmpty(response.headers.get('etag')) ?? etag
      revision += 1
      outcome = 'ok'
      return true
    })()
    let rejectAborted
    const abortPromise = new Promise((_, reject) => {
      rejectAborted = () => reject(requestSignal.reason ?? new Error('Codex model catalog refresh aborted'))
      if (requestSignal.aborted) rejectAborted()
      else requestSignal.addEventListener('abort', rejectAborted, { once: true })
    })
    timer = scheduleTimeout(() => controller.abort(timeoutError), timeoutMs)
    timer.unref?.()
    const promise = Promise.race([work, abortPromise]).catch(error => {
      outcome = 'failed'
      throw error
    }).finally(() => {
      cancelTimeout(timer)
      signal?.removeEventListener('abort', abort)
      requestSignal.removeEventListener('abort', rejectAborted)
      if (refreshing?.promise === promise) {
        refreshing = undefined
        refreshStatus = outcome
      }
    })
    refreshing = { generation: currentGeneration, promise, cancel: () => controller.abort() }
    return promise
  }

  return Object.freeze({
    refresh,
    // A cold catalog must finish loading before a turn resolves its model.
    async ready() {
      if (models !== undefined) return
      try { await refresh() } catch { /* status() exposes the failed lookup */ }
    },
    async ensure(modelId) {
      if (models?.some(model => model.id === modelId)) return
      await this.ready()
      if (models?.some(model => model.id === modelId)) return
      try { await refresh({ modelId }) } catch { /* preserve the last verified catalog */ }
      if (models?.some(model => model.id === modelId)) return
      // A concurrent generic refresh may have won the shared flight.
      if (refreshStatus === 'ok') {
        try { await refresh({ modelId }) } catch { /* the caller reports UNKNOWN_MODEL */ }
      }
    },
    // Spark's research preview retired on 2026-09-14. A bundled offline list
    // must not resurrect it; a successful official catalog remains authoritative.
    getModels: fallback => models ?? fallback.filter(model => model.id !== 'gpt-5.3-codex-spark'),
    metadata: modelId => metadata.get(modelId),
    revision: () => revision,
    capabilityGaps: () => [...metadata.values()]
      .filter(model => model.unsupported && /^[a-z][a-z0-9._-]{0,79}$/u.test(model.id))
      .slice(0, 20)
      .map(model => ({ model: model.id, ...structuredClone(model.unsupported) })),
    status: () => ({ source: models === undefined ? 'fallback' : 'online', refresh: refreshStatus }),
    clear({ retain = true } = {}) {
      generation += 1
      const flight = refreshing
      refreshing = undefined
      flight?.cancel()
      // Keep verified models through an account change; explicit logout drops them.
      if (!retain) {
        models = undefined
        metadata = new Map()
      }
      etag = undefined
      refreshStatus = 'idle'
      revision += 1
    },
  })
}
