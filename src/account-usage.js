const PUBLIC_USAGE_ERRORS = new Set([
  'ChatGPT subscription is not signed in',
  'ChatGPT sign-in needs to be renewed',
])

const publicError = error => PUBLIC_USAGE_ERRORS.has(error?.message)
  ? error.message
  : 'Could not read ChatGPT usage'

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
      const results = []
      for (const account of accounts) {
        signal?.throwIfAborted?.()
        try {
          const usage = await store.withAccount(account.id, () => readerFor(account.id).read({ force, signal }))
          results.push({ id: account.id, usage })
        } catch (error) {
          if (signal?.aborted) throw error
          results.push({ id: account.id, error: publicError(error) })
        }
      }
      return { accounts: results, fetchedAt: Date.now() }
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
