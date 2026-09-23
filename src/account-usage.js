const PUBLIC_USAGE_ERRORS = new Set([
  'ChatGPT subscription is not signed in',
  'ChatGPT sign-in needs to be renewed',
])

const reusedRefreshToken = error => {
  for (let cause = error, depth = 0; cause && depth < 5; cause = cause.cause, depth += 1) {
    if (typeof cause.message === 'string' && /refresh_token_reused/u.test(cause.message)) return true
  }
  return false
}

const publicError = error => PUBLIC_USAGE_ERRORS.has(error?.message)
  ? error.message
  : reusedRefreshToken(error) ? 'ChatGPT sign-in needs to be renewed'
    : 'Could not read ChatGPT usage'

async function mapAccounts(accounts, signal, read) {
  const results = new Array(accounts.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < accounts.length) {
      signal?.throwIfAborted?.()
      const index = nextIndex++
      results[index] = await read(accounts[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, accounts.length) }, () => worker()))
  return results
}

function planWeight(access) {
  try {
    const payload = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString('utf8'))
    const plan = payload?.['https://api.openai.com/auth']?.chatgpt_plan_type?.toLowerCase?.()
    if (plan === 'plus') return 1
    if (['prolite', 'pro-lite', 'pro_lite', 'self_serve_business_prolite'].includes(plan)) return 5
    if (plan === 'pro') return 20
  } catch { /* Unknown plan is excluded rather than assigned an invented capacity. */ }
  return undefined
}

function quotaWindow(usage, seconds) {
  const windows = usage?.rateLimits?.find(limit => limit.id === 'codex')?.windows ?? []
  const window = windows.find(item => Number.isFinite(item.windowSeconds)
    && Math.abs(item.windowSeconds - seconds) <= seconds * 0.05)
  return window === undefined ? undefined : {
    remaining: window.remainingPercent,
    resetAt: Number.isSafeInteger(window.resetsAt) ? window.resetsAt * 1_000 : null,
  }
}

function aggregateWindow(rows, kind) {
  const values = rows.map(row => row.windows?.[kind] && { ...row.windows[kind], weight: row.weight }).filter(Boolean)
  const capacity = values.reduce((total, row) => total + row.weight, 0)
  return {
    remaining: capacity === 0 ? 0 : values.reduce((total, row) => total + row.remaining * row.weight, 0) / capacity,
    loaded: values.length,
    capacity,
    resetAt: values.length === 1 ? values[0].resetAt : null,
  }
}

export function createAccountUsageService({ accountVault, store, createReader }) {
  const readers = new Map()
  const readerFor = id => {
    let reader = readers.get(id)
    if (reader === undefined) {
      reader = createReader(id)
      readers.set(id, reader)
    }
    return reader
  }
  return Object.freeze({
    async readAll({ force = false, signal } = {}) {
      const accounts = await accountVault?.list?.() ?? []
      const results = await mapAccounts(accounts, signal, async account => {
        if (account.enabled === false) {
          return { id: account.id, disabled: true }
        }
        try {
          const usage = await store.withAccount(account.id, () => readerFor(account.id).read({ force, signal }))
          return { id: account.id, usage }
        } catch (error) {
          if (signal?.aborted) throw error
          return { id: account.id, error: publicError(error) }
        }
      })
      return { accounts: results, fetchedAt: Date.now() }
    },
    async readPool({ force = false, signal } = {}) {
      const accounts = (await accountVault?.list?.() ?? []).filter(account => account.enabled !== false)
      const rows = await mapAccounts(accounts, signal, async account => {
        try {
          const scopedCredential = await store.withAccount(account.id, () => store.read('openai-codex', { signal }))
          const weight = planWeight(scopedCredential?.access)
          if (weight === undefined) throw new Error('Unknown ChatGPT plan capacity')
          const usage = await store.withAccount(account.id, () => readerFor(account.id).read({ force, signal }))
          return { weight, windows: { '5h': quotaWindow(usage, 18_000), week: quotaWindow(usage, 604_800) } }
        } catch (error) {
          if (signal?.aborted) throw error
          return { error: publicError(error) }
        }
      })
      return {
        total: accounts.length,
        failed: rows.filter(row => row.error).length,
        accounts: rows,
        windows: { '5h': aggregateWindow(rows, '5h'), week: aggregateWindow(rows, 'week') },
        fetchedAt: Date.now(),
      }
    },
    clear(id) {
      if (id === undefined) {
        for (const reader of readers.values()) reader.clear?.()
        readers.clear()
        return
      }
      readers.get(id)?.clear?.()
      readers.delete(id)
    },
  })
}
