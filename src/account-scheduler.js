import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

const TRANSPORT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE',
  'EOF', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE', 'CODEX_STREAM_INCOMPLETE',
])

function resetDelayFromMessage(message) {
  if (typeof message !== 'string') return undefined
  const relative = /resets_in_seconds[^0-9]{0,12}(\d+)/iu.exec(message)
  if (relative) {
    const seconds = Number(relative[1])
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  }
  const absolute = /resets_at[^0-9]{0,12}(\d{10,13})/iu.exec(message)
  if (!absolute) return undefined
  const value = Number(absolute[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value
  return Math.max(1_000, milliseconds - Date.now())
}

function classifyFailure(failure = {}) {
  const message = String(failure.message ?? '')
  const code = String(failure.code ?? '').toUpperCase()
  const status = Number(failure.status)
  const requested = Number(failure.providerRetryAfterMs)
  const retryAfterMs = Number.isFinite(requested) && requested > 0 ? requested : undefined
  if (['INVALID_REQUEST', 'INVALID_ARGUMENT', 'CONTENT_POLICY_VIOLATION', 'CYBER_POLICY',
    'CONTEXT_LENGTH_EXCEEDED', 'CONTEXT_TOO_LARGE', 'UNSUPPORTED_PARAMETER'].includes(code)
    || /context (?:window|length).{0,60}(?:exceed|too large)|too many tokens/iu.test(message)) {
    return { retryable: false, scope: 'request', reason: 'error', cooldownMs: 0 }
  }
  if (/usage_limit_reached|usage limit|insufficient_quota|quota exceeded|out of budget|image generation quota is unavailable/iu.test(message)
    || ['USAGE_LIMIT_REACHED', 'QUOTA_EXHAUSTED', 'INSUFFICIENT_QUOTA'].includes(code)) {
    return { retryable: true, scope: 'model', reason: 'quota', cooldownMs: resetDelayFromMessage(message) ?? retryAfterMs ?? 15 * 60 * 1000 }
  }
  if (/OVERLOAD|CAPACITY/u.test(code) || /server_is_overloaded|selected model is at capacity|model_at_capacity/iu.test(message)) {
    return { retryable: true, scope: 'provider', reason: 'transient', cooldownMs: retryAfterMs ?? 10 * 1000 }
  }
  if (status === 429 || code.includes('RATE_LIMIT')) {
    return { retryable: true, scope: 'model', reason: 'rate-limit', cooldownMs: retryAfterMs ?? 30 * 1000 }
  }
  if (['MODEL_NOT_FOUND', 'MODEL_UNAVAILABLE', 'MODEL_ACCESS_DENIED'].includes(code)
    || ['CODEX_MODEL_MISMATCH', 'CODEX_IMAGE_INCOMPLETE'].includes(code) || /upstream model mismatch/iu.test(message)
    || /model.{0,100}(?:not available|not found|not supported|does not exist).{0,100}(?:this account|your account|credential)/iu.test(message)
    || /(?:do not have access|don't have access).{0,100}model/iu.test(message)
    || ((status === 400 || status === 404)
      && /model.{0,80}(?:not found|not available|not supported|does not exist|do not have access)/iu.test(message))) {
    return { retryable: true, scope: 'model', reason: 'model-access', cooldownMs: 60 * 1000 }
  }
  if ([401, 403].includes(status) || /AUTH|UNAUTHORIZED|FORBIDDEN/.test(code)
    || /invalidated oauth token|invalid(?:ated)? oauth access token|sign-in needs to be renewed|subscription authorization failed/iu.test(message)) {
    return { retryable: true, scope: 'credential', reason: 'auth', cooldownMs: 60 * 1000 }
  }
  if ([408].includes(status) || TRANSPORT_CODES.has(code) || /^(?:CERT_|ERR_TLS_|ERR_SSL_)/u.test(code)
    || /TIMEOUT|NETWORK|CONNECTION|TRANSPORT|SOCKET|STREAM_INCOMPLETE/u.test(code)
    || /timeout|timed? out|ECONN|EPIPE|EOF|network/iu.test(message)) {
    return { retryable: true, scope: 'transport', reason: 'transient', cooldownMs: retryAfterMs ?? 10 * 1000 }
  }
  if ([500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].includes(status)
    || /SERVICE_UNAVAILABLE|UPSTREAM/u.test(code)
    || /service unavailable/iu.test(message)) {
    return { retryable: true, scope: 'provider', reason: 'transient', cooldownMs: retryAfterMs ?? 10 * 1000 }
  }
  return { retryable: false, scope: 'request', reason: 'error', cooldownMs: 0 }
}

function failureFromError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const status = Number(error?.status) || Number(/\bHTTP (\d{3})\b/iu.exec(message)?.[1]) || undefined
  const causes = []
  for (let current = error; current && causes.length < 5; current = current.cause) causes.push(current)
  const transport = causes.find(item => /^(?:UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ERR_STREAM_PREMATURE_CLOSE)$/iu.test(String(item?.code ?? '')))
  return {
    code: String(transport?.code ?? error?.code ?? error?.cause?.code ?? ''),
    message: `${message}${error?.cause?.message ? `; ${error.cause.message}` : ''}`,
    ...(status ? { status } : {}),
  }
}

const attemptSummary = attempts => attempts.map(item => `${item.label}: ${item.reason}`).join('；')

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function enhancedFailure(chunk, attempts) {
  if (chunk?.type !== 'finish' || !['error', 'aborted'].includes(chunk.reason?.kind) || attempts.length === 0) return chunk
  const failure = chunk.reason.failure ?? { code: 'CODEX_ACCOUNT_POOL_FAILED', message: 'Codex account pool failed' }
  return {
    ...chunk,
    reason: {
      ...chunk.reason,
      failure: {
        ...failure,
        message: `${failure.message}（账号接力：${attemptSummary(attempts)}）`,
      },
    },
  }
}

function accountSafeOptions(options, accountId) {
  if (!Array.isArray(options.messages)) return options
  let changed = false
  const messages = options.messages.map(message => {
    const source = message?.source
    if (!source?.replayState || source.replayState.codexAccountScope === accountId) return message
    // Durable content is the task history. Encrypted reasoning, signatures,
    // response ids and compaction checkpoints are private to the credential
    // that produced them; legacy unscoped replay state is conservatively reset.
    const { replayState: _privateState, ...safeSource } = source
    changed = true
    return { ...message, source: safeSource }
  })
  return changed ? { ...options, messages } : options
}

function tagReplayScope(chunk, accountId) {
  if (chunk?.type !== 'finish' || !chunk.replayState) return chunk
  return { ...chunk, replayState: { ...chunk.replayState, codexAccountScope: accountId } }
}

export class CodexAccountScheduler {
  constructor(vault, options = {}) {
    this.vault = vault
    this.now = options.now ?? Date.now
    this.resolveConfig = options.resolveConfig
    this.cooldowns = new Map()
    this.bindings = new Map()
    this.cursor = 0
    this.weightCursor = 0
    this.fillCurrent = undefined
    this.relayEvents = []
  }

  async config() {
    return await this.resolveConfig?.() ?? this.vault?.scheduler?.() ?? { strategy: 'fill-first', sessionAffinity: true }
  }

  async accounts() {
    return this.vault?.list?.() ?? []
  }

  clearSession(sessionId) {
    if (sessionId !== undefined) this.bindings.delete(String(sessionId))
  }

  markSuccess(id, model) {
    this.cooldowns.delete(id)
    if (model) this.cooldowns.delete(`${id}\u0000${model}`)
  }

  markFailure(id, failure, model) {
    const classified = classifyFailure(failure)
    this.relayEvents.push({ at: this.now(), id, ...(model ? { model } : {}), reason: classified.reason, scope: classified.scope })
    if (this.relayEvents.length > 100) this.relayEvents.shift()
    if (!classified.retryable) return classified
    if (classified.scope === 'credential' || classified.scope === 'model') {
      const key = classified.scope === 'model' && model ? `${id}\u0000${model}` : id
      this.cooldowns.set(key, {
        until: this.now() + Math.max(1_000, Math.min(classified.cooldownMs, 7 * 24 * 60 * 60 * 1000)),
        reason: classified.reason,
        ...(classified.scope === 'model' && model ? { model } : {}),
      })
    }
    if (this.fillCurrent === id) this.fillCurrent = undefined
    for (const [sessionId, accountId] of this.bindings) {
      if (accountId === id) this.bindings.delete(sessionId)
    }
    return classified
  }

  async choose(sessionId, excluded = new Set(), model) {
    const [accounts, config, activeId] = await Promise.all([
      this.accounts(),
      this.config(),
      this.vault?.activeId?.(),
    ])
    const now = this.now()
    for (const [id, state] of this.cooldowns) if (state.until <= now) this.cooldowns.delete(id)

    // Fixed-account mode is an explicit diagnostic override: every conversation
    // uses exactly that enabled account, ignores cross-request cooldown, and
    // never falls through to another account after a retryable pre-output error.
    if (typeof config.fixedAccountId === 'string' && config.fixedAccountId.length > 0) {
      return accounts.find(account => account.id === config.fixedAccountId
        && account.enabled !== false
        && !excluded.has(account.id))
    }

    const enabled = accounts.filter(account => account.enabled !== false
      && !excluded.has(account.id)
      && !this.cooldowns.has(account.id)
      && !(model && this.cooldowns.has(`${account.id}\u0000${model}`)))
    if (enabled.length === 0) return undefined

    const key = sessionId === undefined ? undefined : String(sessionId)
    if (config.sessionAffinity && key) {
      const bound = this.bindings.get(key)
      const hit = enabled.find(account => account.id === bound)
      if (hit) return hit
    }

    const highest = Math.max(...enabled.map(account => account.priority ?? 0))
    const pool = enabled.filter(account => (account.priority ?? 0) === highest)
    let selected
    if (config.strategy === 'round-robin') {
      selected = pool[this.cursor % pool.length]
      this.cursor = (this.cursor + 1) % Number.MAX_SAFE_INTEGER
    } else if (config.strategy === 'weighted-round-robin') {
      const total = pool.reduce((sum, account) => sum + Math.max(1, account.weight ?? 1), 0)
      let point = this.weightCursor % total
      this.weightCursor = (this.weightCursor + 1) % Number.MAX_SAFE_INTEGER
      selected = pool.at(-1)
      for (const account of pool) {
        point -= Math.max(1, account.weight ?? 1)
        if (point < 0) { selected = account; break }
      }
    } else {
      selected = pool.find(account => account.id === this.fillCurrent)
        ?? pool.find(account => account.id === activeId)
        ?? pool[0]
      this.fillCurrent = selected.id
    }
    if (config.sessionAffinity && key) this.bindings.set(key, selected.id)
    return selected
  }

  snapshot() {
    const now = this.now()
    return {
      bindings: this.bindings.size,
      cooldowns: [...this.cooldowns].map(([key, state]) => ({
        id: key.split('\u0000')[0],
        reason: state.reason,
        ...(state.model ? { model: state.model } : {}),
        remainingMs: Math.max(0, state.until - now),
      })),
      relayEvents: this.relayEvents.slice(-20).map(event => ({ ...event })),
    }
  }
}

/** Execute non-LLM subscription calls through the same selected vault account. */
export async function runScheduledAccountOperation({ scheduler, store, sessionId, model, signal, operation }) {
  const accounts = await scheduler.accounts()
  if (accounts.length === 0) throw new LlmError('没有可用的 Codex 账号', 'CODEX_ACCOUNT_POOL_UNAVAILABLE')
  const excluded = new Set(), attempts = []
  let lastError, round = 0, transientInRound = false
  const deadline = Date.now() + 30_000
  while (true) {
    signal?.throwIfAborted()
    const currentAccounts = await scheduler.accounts()
    if (!currentAccounts.some(account => account.enabled !== false && !excluded.has(account.id))) {
      const delay = Math.min(3_000, 150 * 2 ** Math.min(round, 5))
      if (!transientInRound || Date.now() + delay > deadline) break
      round++
      await waitForRetry(delay, signal)
      excluded.clear()
      transientInRound = false
    }
    const account = await scheduler.choose(sessionId, excluded, model)
    if (!account) break
    excluded.add(account.id)
    try {
      const result = await store.withAccount(account.id, () => operation(account))
      scheduler.markSuccess(account.id, model)
      return result
    } catch (error) {
      if (signal?.aborted) throw error
      const classified = scheduler.markFailure(account.id, failureFromError(error), model)
      if (!classified.retryable) throw error
      attempts.push({ label: account.label, reason: classified.reason, scope: classified.scope })
      transientInRound ||= ['transport', 'provider'].includes(classified.scope)
      lastError = error
    }
  }
  if (!lastError) throw new LlmError('没有可用的 Codex 账号', 'CODEX_ACCOUNT_POOL_UNAVAILABLE')
  lastError.message = `${lastError.message}（账号接力：${attemptSummary(attempts)}）`
  throw lastError
}

async function* scopedIterator(store, accountId, iterable) {
  const iterator = store.withAccount(accountId, () => iterable[Symbol.asyncIterator]())
  try {
    while (true) {
      const step = await store.withAccount(accountId, () => iterator.next())
      if (step.done) return
      yield step.value
    }
  } finally {
    if (typeof iterator.return === 'function') {
      await store.withAccount(accountId, () => iterator.return()).catch(() => {})
    }
  }
}

export class ScheduledCodexAdapter extends LlmAdapter {
  constructor(base, scheduler, store, catalog) {
    super()
    this.base = base
    this.scheduler = scheduler
    this.store = store
    this.catalog = catalog
  }

  current(...args) { return typeof this.base.current === 'function' ? this.base.current(...args) : undefined }
  providerInfo(provider) { return this.base.providerInfo(provider) }
  providerRetryPolicy(provider) { return this.base.providerRetryPolicy(provider) }
  imageRequestPricing(provider, model) { return this.base.imageRequestPricing(provider, model) }
  async listModels(provider) {
    await this.catalog?.ready?.()
    return this.base.listModels(provider)
  }
  async resolveModel(provider, model, signal) {
    await this.catalog?.ensure?.(model)
    return this.base.resolveModel(provider, model, signal)
  }

  async prepareCall(provider, model, signal) {
    await this.catalog?.ensure?.(model)
    const prepared = await this.base.prepareCall(provider, model, signal)
    return {
      model: prepared.model,
      stream: options => this.run(options, value => prepared.stream(value)),
    }
  }

  stream(options) {
    return this.run(options, value => this.base.stream(value))
  }

  async *run(options, dispatch) {
    const accounts = await this.scheduler.accounts()
    if (accounts.length === 0) {
      throw new LlmError('没有可用的 Codex 账号：请先登录或导入账号', 'CODEX_ACCOUNT_POOL_UNAVAILABLE')
    }

    const excluded = new Set()
    const attempts = []
    let lastFailureChunk
    let lastError
    let round = 0, transientInRound = false
    const deadline = Date.now() + 30_000
    while (true) {
      options.signal?.throwIfAborted()
      const currentAccounts = await this.scheduler.accounts()
      if (!currentAccounts.some(account => account.enabled !== false && !excluded.has(account.id))) {
        const delay = Math.min(3_000, 150 * 2 ** Math.min(round, 5))
        if (!transientInRound || Date.now() + delay > deadline) break
        round++
        await waitForRetry(delay, options.signal)
        excluded.clear()
        transientInRound = false
      }
      const account = await this.scheduler.choose(options.sessionId, excluded, options.model)
      if (!account) break
      excluded.add(account.id)
      const staged = []
      let failed = false
      try {
        const iterable = this.store.withAccount(account.id, () => dispatch(accountSafeOptions(options, account.id)))
        for await (const chunk of scopedIterator(this.store, account.id, iterable)) {
          if (chunk?.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
            if (options.signal?.aborted) throw options.signal.reason ?? new Error('Request aborted')
            const classified = this.scheduler.markFailure(account.id, chunk.reason.failure, options.model)
            if (!classified.retryable) {
              for (const item of staged) yield item
              yield chunk
              return
            }
            attempts.push({ label: account.label, reason: classified.reason, scope: classified.scope })
            transientInRound ||= ['transport', 'provider'].includes(classified.scope)
            lastFailureChunk = chunk
            failed = true
            break
          }

          staged.push(chunk)
          if (chunk?.type === 'finish') {
            this.scheduler.markSuccess(account.id, options.model)
            // Delay DSH-visible text and tool calls until the upstream turn is
            // complete. A stream that fails after its first token is otherwise
            // impossible to replay without duplicated output or side effects.
            for (const item of staged) yield tagReplayScope(item, account.id)
            return
          }
        }
        if (failed) continue
        const failure = { code: 'CODEX_STREAM_INCOMPLETE', message: 'Codex stream ended before finish' }
        const classified = this.scheduler.markFailure(account.id, failure, options.model)
        attempts.push({ label: account.label, reason: classified.reason, scope: classified.scope })
        transientInRound ||= ['transport', 'provider'].includes(classified.scope)
        lastError = new LlmError(failure.message, failure.code)
      } catch (error) {
        if (options.signal?.aborted) throw error
        const failure = error?.failure ?? {
          code: String(error?.code ?? 'CODEX_TRANSPORT_ERROR'),
          message: error instanceof Error ? error.message : String(error),
          ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
        }
        const classified = this.scheduler.markFailure(account.id, failure, options.model)
        if (!classified.retryable) throw error
        attempts.push({ label: account.label, reason: classified.reason, scope: classified.scope })
        transientInRound ||= ['transport', 'provider'].includes(classified.scope)
        lastError = error
      }
    }

    if (lastFailureChunk) {
      yield enhancedFailure(lastFailureChunk, attempts)
      return
    }
    if (lastError) {
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      throw new LlmError(
        `${message}（账号接力：${attemptSummary(attempts)}）`,
        typeof lastError?.code === 'string' && lastError.code.length > 0 ? lastError.code : 'CODEX_ACCOUNT_POOL_FAILED',
      )
    }
    throw new LlmError(
      '没有可用的 Codex 账号：账号可能已停用、额度耗尽或正在冷却',
      'CODEX_ACCOUNT_POOL_UNAVAILABLE',
    )
  }
}

export { classifyFailure }
