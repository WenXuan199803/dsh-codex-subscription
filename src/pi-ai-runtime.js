// Keep every dependency on pi-ai's Codex-specific public surface in one place.
// The exact peer version makes a DSH update fail visibly until this seam is
// re-audited instead of silently changing authentication or cache semantics.
import { openaiCodexProvider as createOpenAICodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { AsyncLocalStorage } from 'node:async_hooks'
import { officialCodexRequest } from './codex-request.js'
import { normalizeTransportEvent } from './transport-failure.js'
import { guardSseModel } from './model-integrity.js'
import {
  CONTEXT_MODE_CUSTOM,
  CONTEXT_MODE_EXTENDED,
  customContextModelKey,
  OUTPUT_VERBOSITY_DEFAULT,
  SPEED_MODE_FAST,
  supportsCodexFastMode,
  modelContextMaximum,
  clampModelContext,
} from './settings-contract.js'

const FAST_SERVICE_TIER = 'priority'

function quotaRetryAfterMs(payload) {
  const quota = payload?.error ?? payload
  if (quota?.type !== 'usage_limit_reached' && quota?.code !== 'usage_limit_reached') return undefined
  const seconds = Number(quota.resets_in_seconds)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const absolute = Number(quota.resets_at)
  if (!Number.isFinite(absolute) || absolute <= 0) return undefined
  const at = absolute < 10_000_000_000 ? absolute * 1000 : absolute
  return Math.max(1_000, at - Date.now())
}

export { createModels } from '@earendil-works/pi-ai'
export { createOpenAICodexProvider as openaiCodexProvider }

/**
 * Preserve pi-ai's native Codex OAuth provider while allowing DSH's generic
 * PiAiAdapter to pass the access token resolved by the host credential store.
 *
 * PiAiAdapter owns a request-local Models collection backed by the same DSH
 * credential store as this provider. A pure OAuth provider ignores its
 * `apiKey` request override and otherwise fails before dispatch with "Provider
 * is not configured". This non-interactive bridge teaches that collection how
 * to consume only the already-refreshed token for this request; login, refresh,
 * persistence, headers, transport, and model behavior remain owned by the
 * original provider.
 */
export function openaiCodexSubscriptionProvider({
  resolveSpeedMode = () => undefined,
  resolveOutputVerbosity = () => OUTPUT_VERBOSITY_DEFAULT,
  resolveContextMode = () => undefined,
  resolveCustomContextWindow = () => undefined,
  catalog,
  connection,
  compaction,
  runNetwork = (_area, operation) => operation(),
} = {}) {
  const provider = createOpenAICodexProvider()
  const requestToken = Object.freeze({
    name: 'DSH-managed Codex OAuth request token',
    async resolve({ credential }) {
      const token = credential?.type === 'api_key' ? credential.key : undefined
      if (typeof token !== 'string' || token.length === 0) return undefined
      return { auth: { apiKey: token }, source: 'DSH-managed OAuth request' }
    },
  })
  const modelMetadata = model => catalog?.metadata(model?.id)
  const supportsVerbosity = model => modelMetadata(model)?.supportVerbosity ?? model?.id !== 'gpt-5.3-codex-spark'
  const withPreferences = (model, options = {}) => {
    const metadata = modelMetadata(model)
    const requestedVerbosity = resolveOutputVerbosity()
    const textVerbosity = supportsVerbosity(model)
      ? requestedVerbosity === OUTPUT_VERBOSITY_DEFAULT
        ? metadata?.defaultVerbosity ?? 'medium'
        : requestedVerbosity
      : undefined
    const fast = resolveSpeedMode() === SPEED_MODE_FAST
      && (metadata?.supportsFast ?? supportsCodexFastMode(model?.id))
    const onPayload = options.onPayload
    return {
      ...options,
      requestedModel: model.id,
      ...(textVerbosity === undefined ? {} : { textVerbosity }),
      ...(fast ? { serviceTier: FAST_SERVICE_TIER } : {}),
      ...(metadata?.useResponsesLite === true ? {
        headers: { ...options.headers, 'x-openai-internal-codex-responses-lite': 'true' },
      } : {}),
      async onPayload(payload, requestModel) {
        const preferred = {
          ...payload,
          ...(textVerbosity === undefined ? {} : { text: { ...(payload.text ?? {}), verbosity: textVerbosity } }),
          ...(fast ? { service_tier: FAST_SERVICE_TIER } : {}),
        }
        const managed = compaction?.preparePayload(preferred, model?.contextWindow) ?? preferred
        const next = await onPayload?.(managed, requestModel)
        const requested = {
          ...(next ?? managed),
          ...(textVerbosity === undefined ? {} : { text: { ...((next ?? managed).text ?? {}), verbosity: textVerbosity } }),
          ...(fast ? { service_tier: FAST_SERVICE_TIER } : {}),
        }
        return officialCodexRequest(requested, metadata)
      },
    }
  }
  const getModels = () => (catalog?.getModels(provider.getModels()) ?? provider.getModels()).map(model => {
    const maximum = modelContextMaximum(model)
    const mode = resolveContextMode()
    if (model.id === 'gpt-5.3-codex-spark' || ![CONTEXT_MODE_EXTENDED, CONTEXT_MODE_CUSTOM].includes(mode)) return model
    if (mode === CONTEXT_MODE_EXTENDED) {
      // Prefer the explicit catalog maximum; known offline models keep audited presets.
      const contextWindow = maximum
      return { ...model, contextWindow }
    }
    const requested = clampModelContext(resolveCustomContextWindow(customContextModelKey(model.id)), maximum, model.contextWindow)
    return { ...model, contextWindow: requested }
  })
  const networkIterable = (factory, optionsFactory, requestedModel) => {
    let iterator
    let ready
    let running
    let finish
    const relayMetadata = {}
    const start = () => {
      if (ready) return ready
      ready = new Promise((resolve, reject) => {
        Promise.resolve().then(async () => {
          await catalog?.ready?.()
          const options = typeof optionsFactory === 'function' ? optionsFactory() : optionsFactory
          const request = await (connection?.prepare(options) ?? Promise.resolve({ options }))
          const networkOptions = compaction?.networkOptions(request.network) ?? request.network ?? {}
          running = Promise.resolve().then(() => runNetwork('model', async () => {
            const completed = new Promise(done => { finish = done })
            iterator = factory(compaction?.requestOptions(request.options) ?? request.options)[Symbol.asyncIterator]()
            const scoped = AsyncLocalStorage.snapshot()
            resolve({ request, scoped })
            await completed
          }, {
            ...networkOptions,
            expectedModel: requestedModel,
            async transformResponse(response, target) {
              const transformed = await networkOptions.transformResponse?.(response, target) ?? response
              if (!transformed.ok && target.hostname === 'chatgpt.com' && target.pathname === '/backend-api/codex/responses') {
                try { relayMetadata.retryAfterMs = quotaRetryAfterMs(await transformed.clone().json()) } catch { /* original response remains authoritative */ }
              }
              return guardSseModel(transformed, target, requestedModel, event => {
                if (event?.type !== 'response.failed' && event?.type !== 'error') return
                const delay = quotaRetryAfterMs(event.response?.error ?? event.error)
                if (delay > 0) relayMetadata.retryAfterMs = delay
              })
            },
          })).catch(reject)
        }).catch(reject)
      })
      return ready
    }
    const step = async (method, value) => {
      const { request, scoped } = await start()
      try {
        const result = await scoped(() => iterator[method]?.(value)
          ?? (method === 'throw' ? Promise.reject(value) : Promise.resolve({ done: true, value })))
        if (result.done || method === 'return') {
          finish?.()
          await running
        }
        if (result.done) return result
        let event = normalizeTransportEvent(result.value, request.options?.signal)
        if (event?.type === 'error' && relayMetadata.retryAfterMs > 0
          && /usage limit|usage_limit_reached|quota/iu.test(event.error?.errorMessage ?? '')) {
          event = { ...event, error: { ...event.error,
            errorMessage: `${event.error.errorMessage} resets_in_seconds: ${Math.ceil(relayMetadata.retryAfterMs / 1000)}` } }
        }
        return { ...result, value: event }
      } catch (error) {
        finish?.()
        await running?.catch(() => {})
        throw error
      }
    }
    return {
      [Symbol.asyncIterator]() { return this },
      next: value => step('next', value),
      return: value => ready || iterator ? step('return', value) : Promise.resolve({ done: true, value }),
      throw: error => ready || iterator ? step('throw', error) : Promise.reject(error),
    }
  }
  return Object.freeze({
    ...provider,
    auth: Object.freeze({ ...provider.auth, apiKey: requestToken }),
    getModels,
    stream: (model, context, options) => networkIterable(prepared => provider.stream(model, context, prepared), () => withPreferences(model, options), model.id),
    streamSimple: (model, context, options) => networkIterable(prepared => provider.streamSimple(model, context, prepared), () => withPreferences(model, options), model.id),
  })
}

export const PI_AI_RUNTIME_VERSIONS = Object.freeze(['0.82.1', '0.85.1'])
