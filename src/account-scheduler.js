import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

const RETRYABLE_STATUS = new Set([401, 403, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526])

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
  if (/usage_limit_reached|usage limit|insufficient_quota|quota exceeded|out of budget/iu.test(message)
    || ['USAGE_LIMIT_REACHED', 'QUOTA_EXHAUSTED', 'INSUFFICIENT_QUOTA'].includes(code)) {
    return { retryable: true, reason: 'quota', cooldownMs: resetDelayFromMessage(message) ?? retryAfterMs ?? 15 * 60 * 1000 }
  }
  if (status === 429 || code.includes('RATE_LIMIT')) {
    return { retryable: true, reason: 'rate-limit', cooldownMs: retryAfterMs ?? 30 * 1000 }
  }
  if ([401, 403].includes(status) || /AUTH|UNAUTHORIZED|FORBIDDEN/.test(code)
    || /invalidated oauth token|invalid(?:ated)? oauth access token/iu.test(message)) {
    return { retryable: true, reason: 'auth', cooldownMs: 60 * 1000 }
  }
  if ([408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526].includes(status)
    || /OVERLOAD|SERVICE_UNAVAILABLE|UPSTREAM|TIMEOUT|NETWORK|CONNECTION/.test(code)
    || /overloaded|service unavailable|timed? out|ECONN|EPIPE|EOF|network/iu.test(message)) {
    return { retryable: true, reason: 'transient', cooldownMs: retryAfterMs ?? 10 * 1000 }
  }
  return { retryable: RETRYABLE_STATUS.has(status), reason: 'error', cooldownMs: retryAfterMs ?? 10 * 1000 }
}

const isCommittedChunk = chunk => [
  'block-start', 'block-end', 'text-delta', 'reasoning-delta', 'tool-call-delta',
].includes(chunk?.type)

const attemptSummary = attempts => attempts.map(item => `${item.label}: ${item.reason}`).join('；')

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

  markSuccess(id) {
    this.cooldowns.delete(id)
  }

  markFailure(id, failure) {
    const classified = classifyFailure(failure)
    if (!classified.retryable) return classified
    this.cooldowns.set(id, {
      until: this.now() + Math.max(1_000, Math.min(classified.cooldownMs, 7 * 24 * 60 * 60 * 1000)),
      reason: classified.reason,
    })
    if (this.fillCurrent === id) this.fillCurrent = undefined
    for (const [sessionId, accountId] of this.bindings) {
      if (accountId === id) this.bindings.delete(sessionId)
    }
    return classified
  }

  async choose(sessionId, excluded = new Set()) {
    const [accounts, config, activeId] = await Promise.all([
      this.accounts(),
      this.config(),
      this.vault?.activeId?.(),
    ])
    const now = this.now()
    for (const [id, state] of this.cooldowns) if (state.until <= now) this.cooldowns.delete(id)
    const enabled = accounts.filter(account => account.enabled !== false
      && !excluded.has(account.id)
      && !this.cooldowns.has(account.id))
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
      cooldowns: [...this.cooldowns].map(([id, state]) => ({
        id,
        reason: state.reason,
        remainingMs: Math.max(0, state.until - now),
      })),
    }
  }
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
  constructor(base, scheduler, store) {
    super()
    this.base = base
    this.scheduler = scheduler
    this.store = store
  }

  current(...args) { return typeof this.base.current === 'function' ? this.base.current(...args) : undefined }
  providerInfo(provider) { return this.base.providerInfo(provider) }
  providerRetryPolicy(provider) { return this.base.providerRetryPolicy(provider) }
  imageRequestPricing(provider, model) { return this.base.imageRequestPricing(provider, model) }
  listModels(provider) { return this.base.listModels(provider) }
  resolveModel(provider, model, signal) { return this.base.resolveModel(provider, model, signal) }

  async prepareCall(provider, model, signal) {
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
    while (excluded.size < accounts.length) {
      options.signal?.throwIfAborted()
      const account = await this.scheduler.choose(options.sessionId, excluded)
      if (!account) break
      excluded.add(account.id)
      let committed = false
      const staged = []
      try {
        const iterable = this.store.withAccount(account.id, () => dispatch(options))
        for await (const chunk of scopedIterator(this.store, account.id, iterable)) {
          if (chunk?.type === 'finish' && ['error', 'aborted'].includes(chunk.reason?.kind)) {
            if (options.signal?.aborted || committed) {
              for (const item of staged) yield item
              yield chunk
              return
            }
            const classified = this.scheduler.markFailure(account.id, chunk.reason.failure)
            if (!classified.retryable) {
              for (const item of staged) yield item
              yield chunk
              return
            }
            attempts.push({ label: account.label, reason: classified.reason })
            lastFailureChunk = chunk
            break
          }

          staged.push(chunk)
          if (!committed && isCommittedChunk(chunk)) {
            committed = true
            this.scheduler.markSuccess(account.id)
            for (const item of staged.splice(0)) yield item
          } else if (committed) {
            yield staged.shift()
          }

          if (chunk?.type === 'finish') {
            this.scheduler.markSuccess(account.id)
            for (const item of staged.splice(0)) yield item
            return
          }
        }
      } catch (error) {
        if (options.signal?.aborted || committed) throw error
        const failure = error?.failure ?? {
          code: String(error?.code ?? 'CODEX_TRANSPORT_ERROR'),
          message: error instanceof Error ? error.message : String(error),
          ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
        }
        const classified = this.scheduler.markFailure(account.id, failure)
        if (!classified.retryable) throw error
        attempts.push({ label: account.label, reason: classified.reason })
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
