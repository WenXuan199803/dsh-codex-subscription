const PREFIX = 'dsh-codex-subscription/usage-cache-v1:'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function quotaProjection(value) {
  if (!Number.isFinite(value?.fetchedAt) || !Array.isArray(value.rateLimits)) return undefined
  const rateLimits = value.rateLimits.slice(0, 16).map(limit => {
    if (typeof limit?.id !== 'string' || !Array.isArray(limit.windows)) return undefined
    const windows = limit.windows.slice(0, 8).map(window => {
      if (!Number.isFinite(window?.remainingPercent) || window.remainingPercent < 0
        || window.remainingPercent > 100 || !Number.isFinite(window.windowSeconds)
        || window.windowSeconds <= 0) return undefined
      return {
        remainingPercent: window.remainingPercent,
        usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : 100 - window.remainingPercent,
        windowSeconds: window.windowSeconds,
        ...(Number.isSafeInteger(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
      }
    })
    if (windows.some(window => window === undefined)) return undefined
    return { id: limit.id.slice(0, 80),
      ...(typeof limit.name === 'string' ? { name: limit.name.slice(0, 120) } : {}), windows }
  })
  if (rateLimits.some(limit => limit === undefined) || rateLimits.length === 0) return undefined
  return { fetchedAt: value.fetchedAt, rateLimits }
}

export function createUsageCache({ storage = () => globalThis.localStorage, now = Date.now } = {}) {
  const memory = new Map()
  const backing = () => { try { return storage() } catch { return undefined } }
  const keyFor = accountKey => `${PREFIX}${encodeURIComponent(accountKey)}`
  const freshEnough = value => value !== undefined && now() - value.fetchedAt >= 0
    && now() - value.fetchedAt <= MAX_AGE_MS
  return Object.freeze({
    read(accountKey) {
      if (typeof accountKey !== 'string' || accountKey.length === 0) return undefined
      let value = memory.get(accountKey)
      if (value === undefined) {
        try { value = quotaProjection(JSON.parse(backing()?.getItem(keyFor(accountKey)) ?? 'null')) } catch { return undefined }
      }
      if (!freshEnough(value)) { memory.delete(accountKey); return undefined }
      memory.set(accountKey, value)
      return structuredClone(value)
    },
    write(accountKey, usage) {
      if (typeof accountKey !== 'string' || accountKey.length === 0) return
      const value = quotaProjection(usage)
      if (!freshEnough(value)) return
      memory.set(accountKey, value)
      try { backing()?.setItem(keyFor(accountKey), JSON.stringify(value)) } catch { /* Memory cache still works. */ }
    },
    clear() {
      memory.clear()
      const target = backing()
      if (!target) return
      try {
        for (let index = target.length - 1; index >= 0; index -= 1) {
          const key = target.key(index)
          if (key?.startsWith(PREFIX)) target.removeItem(key)
        }
      } catch { /* Storage may be unavailable. */ }
    },
    prune(accountKeys) {
      const allowed = new Set(accountKeys)
      for (const id of memory.keys()) if (!allowed.has(id)) memory.delete(id)
      const target = backing()
      if (!target) return
      try {
        for (let index = target.length - 1; index >= 0; index -= 1) {
          const key = target.key(index)
          if (key?.startsWith(PREFIX) && !allowed.has(decodeURIComponent(key.slice(PREFIX.length)))) target.removeItem(key)
        }
      } catch { /* Storage may be unavailable. */ }
    },
  })
}

export const usageCache = createUsageCache()
