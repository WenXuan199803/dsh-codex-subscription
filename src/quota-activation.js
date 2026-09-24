const FIVE_HOUR_SECONDS = 18_000
const WEEK_SECONDS = 604_800
const ACTIVATION_GRACE_MS = 2_000
const RETRY_BASE_MS = 15 * 60 * 1000
const RETRY_MAX_MS = 60 * 60 * 1000

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined
  const part = token.split('.')[1]
  if (!part) return undefined
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) } catch { return undefined }
}

export function credentialPlanType(credential) {
  const payload = decodeJwtPayload(credential?.access)
  const plan = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type
  return typeof plan === 'string' ? plan.toLowerCase() : undefined
}

function quotaWindow(usage, seconds) {
  const windows = usage?.rateLimits?.find(limit => limit.id === 'codex')?.windows ?? []
  return windows.find(window => Number.isFinite(window.windowSeconds)
    && Math.abs(window.windowSeconds - seconds) <= seconds * 0.05)
}

export async function completeMinimalQuotaActivation(models, model, now = Date.now) {
  return models.completeSimple(model, {
    messages: [{ role: 'user', content: 'Reply HI', timestamp: now() }],
  }, {
    reasoning: 'low',
    cacheRetention: 'none',
  })
}

export function createQuotaActivationService({
  listAccounts,
  readCredential,
  activate,
  readUsage,
  enabled = () => true,
  now = Date.now,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = handle => clearTimeout(handle),
  onError = () => {},
} = {}) {
  const timers = new Map()
  const known = new Set()
  const retries = new Map()
  let disposed = false
  let tail = Promise.resolve()

  const cancelTimer = id => {
    const handle = timers.get(id)
    if (handle !== undefined) clearTimer(handle)
    timers.delete(id)
  }
  const schedule = (id, at) => {
    cancelTimer(id)
    if (disposed || !enabled()) return
    const delay = Math.max(1_000, at - now())
    timers.set(id, setTimer(() => {
      timers.delete(id)
      void enqueue(() => run(id))
    }, delay))
  }
  const eligible = async id => {
    const account = (await listAccounts()).find(candidate => candidate.id === id)
    if (account === undefined || account.enabled === false) return false
    const credential = await readCredential(id)
    return credentialPlanType(credential) === 'plus'
  }
  const nextFromUsage = usage => {
    const fiveHour = quotaWindow(usage, FIVE_HOUR_SECONDS)
    return Number.isSafeInteger(fiveHour?.resetsAt) && fiveHour.resetsAt * 1_000 > now()
      ? fiveHour.resetsAt * 1_000 + ACTIVATION_GRACE_MS
      : now() + FIVE_HOUR_SECONDS * 1_000 + ACTIVATION_GRACE_MS
  }
  const run = async id => {
    if (disposed || !enabled() || !(await eligible(id))) {
      cancelTimer(id); known.delete(id); retries.delete(id); return
    }
    try {
      await activate(id)
      retries.delete(id)
      const row = await readUsage(id).catch(() => undefined)
      schedule(id, nextFromUsage(row?.usage ?? row))
    } catch (error) {
      const attempt = (retries.get(id) ?? 0) + 1
      retries.set(id, attempt)
      const row = await readUsage(id).catch(() => undefined)
      const usage = row?.usage ?? row
      const week = quotaWindow(usage, WEEK_SECONDS)
      const next = Number(week?.remainingPercent) <= 0 && Number.isSafeInteger(week?.resetsAt) && week.resetsAt * 1_000 > now()
        ? week.resetsAt * 1_000 + ACTIVATION_GRACE_MS
        : now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 2))
      schedule(id, next)
      onError(error, id)
    }
  }
  function enqueue(operation) {
    const current = tail.catch(() => undefined).then(operation)
    tail = current.catch(() => undefined)
    return current
  }

  return Object.freeze({
    async sync() {
      if (disposed) return
      if (!enabled()) {
        for (const id of timers.keys()) cancelTimer(id)
        known.clear()
        retries.clear()
        return
      }
      const accounts = await listAccounts()
      const visible = new Set(accounts.map(account => account.id))
      for (const id of [...known]) {
        if (!visible.has(id)) { cancelTimer(id); known.delete(id); retries.delete(id) }
      }
      const pending = []
      for (const account of accounts) {
        if (account.enabled === false) {
          cancelTimer(account.id); known.delete(account.id); retries.delete(account.id); continue
        }
        const credential = await readCredential(account.id)
        if (credentialPlanType(credential) !== 'plus') {
          cancelTimer(account.id); known.delete(account.id); retries.delete(account.id); continue
        }
        if (known.has(account.id)) continue
        known.add(account.id)
        pending.push(enqueue(() => run(account.id)))
      }
      await Promise.allSettled(pending)
    },
    dispose() {
      disposed = true
      for (const id of timers.keys()) cancelTimer(id)
      known.clear()
      retries.clear()
    },
    snapshot() {
      return { accounts: known.size, timers: timers.size }
    },
  })
}
