// Keep every dependency on pi-ai's Codex-specific public surface in one place.
// The exact peer version makes a DSH update fail visibly until this seam is
// re-audited instead of silently changing authentication or cache semantics.
import { openaiCodexProvider as createOpenAICodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { officialCodexRequest } from './codex-request.js'
import { AsyncLocalStorage } from 'node:async_hooks'
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
  resolveTransport = () => undefined,
  resolveSessionId = sessionId => sessionId,
  catalog,
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
  const providerEnv = Object.freeze(Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
  ))
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
    const transport = resolveTransport()
    const sessionId = resolveSessionId(options.sessionId)
    return {
      ...options,
      env: options.env ?? providerEnv,
      ...(transport === undefined ? {} : { transport }),
      ...(sessionId === undefined ? {} : { sessionId }),
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
        const next = await onPayload?.(preferred, requestModel)
        return officialCodexRequest({
          ...(next ?? preferred),
          ...(textVerbosity === undefined ? {} : { text: { ...((next ?? preferred).text ?? {}), verbosity: textVerbosity } }),
          ...(fast ? { service_tier: FAST_SERVICE_TIER } : {}),
        }, metadata)
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
  const networkIterable = factory => {
    let ready, running, finish
    const start = () => {
      if (ready) return ready
      ready = new Promise((resolve, reject) => {
        running = Promise.resolve().then(() => runNetwork('model', async () => {
          const completed = new Promise(done => { finish = done })
          const iterator = (await factory())[Symbol.asyncIterator]()
          const scoped = AsyncLocalStorage.snapshot()
          resolve({ iterator, scoped })
          await completed
        })).catch(reject)
      })
      return ready
    }
    const invoke = async (method, value) => {
      const { iterator, scoped } = await start()
      try {
        const result = await scoped(() => iterator[method]?.(value) ?? { done: true, value })
        if (result.done || method === 'return') { finish(); await running }
        return result
      } catch (error) { finish(); await running; throw error }
    }
    return {
      [Symbol.asyncIterator]() { return this },
      next: value => invoke('next', value),
      return: value => invoke('return', value),
      throw: error => invoke('throw', error),
    }
  }
  return Object.freeze({
    ...provider,
    auth: Object.freeze({ ...provider.auth, apiKey: requestToken }),
    getModels,
    stream: (model, context, options) => networkIterable(async () => {
      await catalog?.ready?.()
      return provider.stream(model, context, withPreferences(model, options))
    }),
    streamSimple: (model, context, options) => networkIterable(async () => {
      await catalog?.ready?.()
      return provider.streamSimple(model, context, withPreferences(model, options))
    }),
  })
}

export const PI_AI_RUNTIME_VERSIONS = Object.freeze(['0.82.1', '0.85.1'])
