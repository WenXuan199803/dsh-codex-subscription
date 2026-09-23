import { randomUUID } from 'node:crypto'

const VERSION = 1
const DEFAULT_LABEL = 'Account 1'
const clone = value => value === undefined ? undefined : structuredClone(value)
const EMAIL_MAX_LENGTH = 254
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const SCHEDULER_STRATEGIES = new Set(['fill-first', 'round-robin', 'weighted-round-robin'])

function normalizePriority(value) {
  return Number.isInteger(value) && value >= -1000 && value <= 1000 ? value : 0
}

function normalizeWeight(value) {
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 1
}

function normalizeScheduler(value = {}) {
  return {
    strategy: SCHEDULER_STRATEGIES.has(value?.strategy) ? value.strategy : 'fill-first',
    sessionAffinity: value?.sessionAffinity !== false,
  }
}

/** Keep only a bounded, display-safe email address from a trusted OAuth result. */
export function normalizeAccountEmail(value) {
  if (typeof value !== 'string') return undefined
  const email = value.trim()
  return email.length > 0 && email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email)
    ? email
    : undefined
}

function decodeJwtPayload(access) {
  if (typeof access !== 'string') return undefined
  const encoded = access.split('.')[1]
  if (typeof encoded !== 'string' || encoded.length === 0) return undefined
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

function emailFromAccessToken(access) {
  const payload = decodeJwtPayload(access)
  return normalizeAccountEmail(
    payload?.['https://api.openai.com/profile']?.email ?? payload?.email,
  )
}

/** Normalize the one non-secret account attribute that may cross the UI boundary. */
export function sanitizeOAuthCredential(value) {
  const credential = assertOAuthCredential(value)
  const tokenAccountId = decodeJwtPayload(credential.access)?.['https://api.openai.com/auth']?.chatgpt_account_id
  if (typeof tokenAccountId === 'string' && tokenAccountId.length > 0) credential.accountId = tokenAccountId
  const email = emailFromAccessToken(credential.access) ?? normalizeAccountEmail(credential.email)
  if (email === undefined) {
    delete credential.email
    return credential
  }
  return { ...credential, email }
}

function assertOAuthCredential(value) {
  if (value === null || typeof value !== 'object'
    || value.type !== 'oauth'
    || typeof value.access !== 'string' || value.access.length === 0
    || typeof value.refresh !== 'string' || value.refresh.length === 0
    || typeof value.expires !== 'number' || !Number.isFinite(value.expires)) {
    throw new Error('Codex account vault received a malformed OAuth credential')
  }
  return clone(value)
}

function parseOAuthCredential(value) {
  try {
    return assertOAuthCredential(JSON.parse(value))
  } catch (error) {
    if (error?.message === 'Codex account vault received a malformed OAuth credential') throw error
    throw new Error('Codex account vault contains malformed OAuth JSON', { cause: error })
  }
}

function normalizeLabel(value) {
  if (typeof value !== 'string') throw new Error('Codex account label must be text')
  const label = value.trim().replace(/\s+/gu, ' ')
  if (label.length === 0 || label.length > 48) throw new Error('Codex account label must contain 1 to 48 characters')
  return label
}

function sameAccountIdentity(left, right) {
  const leftAccountId = typeof left?.accountId === 'string' && left.accountId.length > 0 ? left.accountId : undefined
  const rightAccountId = typeof right?.accountId === 'string' && right.accountId.length > 0 ? right.accountId : undefined
  if (leftAccountId !== undefined && rightAccountId !== undefined) return leftAccountId === rightAccountId
  const leftEmail = normalizeAccountEmail(left?.email)?.toLowerCase()
  const rightEmail = normalizeAccountEmail(right?.email)?.toLowerCase()
  return leftEmail !== undefined && rightEmail !== undefined && leftEmail === rightEmail
}

function sameOAuthCredential(left, right) {
  return left?.type === right?.type
    && left?.access === right?.access
    && left?.refresh === right?.refresh
    && left?.expires === right?.expires
    && left?.accountId === right?.accountId
    && normalizeAccountEmail(left?.email)?.toLowerCase() === normalizeAccountEmail(right?.email)?.toLowerCase()
}

function matchingAccountIndex(accounts, credential) {
  const identity = accounts.findIndex(account => sameAccountIdentity(account.credential, credential))
  if (identity >= 0) return identity
  return accounts.findIndex(account => account.credential.access === credential.access
    || account.credential.refresh === credential.refresh)
}

function assertVaultRecord(record) {
  if (record?.kind !== 'grant' || record.payload?.version !== VERSION
    || typeof record.payload.activeId !== 'string'
    || !Array.isArray(record.payload.accounts) || record.payload.accounts.length === 0) {
    throw new Error('Codex account vault contains a malformed grant record')
  }
  const ids = new Set()
  const accounts = record.payload.accounts.map(account => {
    if (account === null || typeof account !== 'object' || typeof account.id !== 'string' || account.id.length === 0
      || ids.has(account.id)) throw new Error('Codex account vault contains a malformed account id')
    ids.add(account.id)
    return {
      id: account.id,
      label: normalizeLabel(account.label),
      credential: sanitizeOAuthCredential(account.credential),
      enabled: account.enabled !== false,
      priority: normalizePriority(account.priority),
      weight: normalizeWeight(account.weight),
    }
  })
  if (!ids.has(record.payload.activeId)) throw new Error('Codex account vault active account is missing')
  const legacyAccountId = record.payload.legacyAccountId
  if (legacyAccountId !== undefined && !ids.has(legacyAccountId)) {
    throw new Error('Codex account vault legacy account is missing')
  }
  return {
    version: VERSION,
    activeId: record.payload.activeId,
    ...(legacyAccountId === undefined ? {} : { legacyAccountId }),
    accounts,
    scheduler: normalizeScheduler(record.payload.scheduler),
  }
}

const grant = payload => ({ kind: 'grant', payload })

export class PendingOAuthCredentialStore {
  #credential

  async read(providerId) {
    if (providerId !== 'openai-codex') throw new Error('Pending Codex login received an unknown provider')
    return clone(this.#credential)
  }

  async list() {
    return this.#credential === undefined ? [] : [{ providerId: 'openai-codex', type: 'oauth' }]
  }

  async modify(providerId, update) {
    if (providerId !== 'openai-codex') throw new Error('Pending Codex login received an unknown provider')
    const next = await update(clone(this.#credential))
    if (next !== undefined) this.#credential = sanitizeOAuthCredential(next)
    return clone(this.#credential)
  }

  async delete(providerId) {
    if (providerId !== 'openai-codex') throw new Error('Pending Codex login received an unknown provider')
    this.#credential = undefined
  }

  credential() {
    return clone(this.#credential)
  }
}

/**
 * Multi-account owner state stored in DSH's atomic plugin credential record.
 * The old single-account reference remains as a rollback source and is kept in
 * sync whenever that imported account rotates its refresh token.
 */
export class DshOAuthAccountVault {
  #tail = Promise.resolve()

  constructor(credentials, options) {
    if (credentials === undefined || credentials === null
      || typeof credentials.readRecord !== 'function'
      || typeof credentials.modifyRecord !== 'function') {
      throw new Error('Codex multi-account requires DSH credential records')
    }
    this.credentials = credentials
    this.key = options.key
    this.legacyRef = options.legacyRef
    this.legacyRefs = Object.freeze([...(options.legacyRefs ?? [])])
    this.createId = options.createId ?? randomUUID
    this.onLegacySyncFailure = options.onLegacySyncFailure ?? (() => {})
  }

  #enqueue(operation) {
    const current = this.#tail.catch(() => undefined).then(operation)
    this.#tail = current.catch(() => undefined)
    return current
  }

  async #legacyCredential() {
    for (const ref of [this.legacyRef, ...this.legacyRefs]) {
      const hit = await this.credentials.resolve(ref)
      if (hit?.value === undefined || hit.value === '') continue
      return { ref, credential: parseOAuthCredential(hit.value) }
    }
    return undefined
  }

  async #ensurePayload() {
    const existing = await this.credentials.readRecord(this.key)
    if (existing !== undefined) {
      const payload = assertVaultRecord(existing)
      if (payload.accounts.find(account => account.id === payload.activeId)?.enabled !== false) return payload
      const replacement = payload.accounts.find(account => account.enabled !== false)
      if (replacement === undefined) return payload
      const repaired = await this.credentials.modifyRecord(this.key, current => {
        const latest = assertVaultRecord(current)
        if (latest.accounts.find(account => account.id === latest.activeId)?.enabled !== false) return current
        const next = latest.accounts.find(account => account.enabled !== false)
        return grant({ ...latest, activeId: next.id })
      })
      return assertVaultRecord(repaired)
    }
    const legacy = await this.#legacyCredential()
    if (legacy === undefined) return undefined
    const id = this.createId()
    const created = await this.credentials.modifyRecord(this.key, current => {
      if (current !== undefined) return Promise.resolve(current)
      return Promise.resolve(grant({
        version: VERSION,
        activeId: id,
        legacyAccountId: id,
        accounts: [{ id, label: DEFAULT_LABEL, credential: legacy.credential, enabled: true, priority: 0, weight: 1 }],
        scheduler: normalizeScheduler(),
      }))
    })
    return assertVaultRecord(created)
  }

  async #modifyPayload(update) {
    await this.#ensurePayload()
    let previousLegacy
    const nextRecord = await this.credentials.modifyRecord(this.key, async current => {
      if (current === undefined) throw new Error('Codex account vault is not signed in')
      const payload = assertVaultRecord(current)
      previousLegacy = payload.accounts.find(account => account.id === payload.legacyAccountId)?.credential
      const next = await update(clone(payload))
      return grant(next)
    })
    const payload = assertVaultRecord(nextRecord)
    const legacy = payload.accounts.find(account => account.id === payload.legacyAccountId)?.credential
    try {
      if (legacy === undefined) {
        if (previousLegacy !== undefined) await this.credentials.unset(this.legacyRef)
      } else if (JSON.stringify(legacy) !== JSON.stringify(previousLegacy)) {
        await this.credentials.set(this.legacyRef, JSON.stringify(legacy))
      }
    } catch {
      // The atomic grant record is authoritative. A read-only legacy source may
      // prevent rollback mirroring, but must not make a committed switch look failed.
      this.onLegacySyncFailure()
    }
    return payload
  }

  list() {
    return this.#enqueue(async () => {
      const payload = await this.#ensurePayload()
      if (payload === undefined) return []
      return payload.accounts.map(account => ({
        id: account.id,
        label: account.label,
        active: account.id === payload.activeId,
        ...(account.enabled === false ? { enabled: false } : {}),
        ...(normalizePriority(account.priority) === 0 ? {} : { priority: normalizePriority(account.priority) }),
        ...(normalizeWeight(account.weight) === 1 ? {} : { weight: normalizeWeight(account.weight) }),
        expiresAt: account.credential.expires,
        ...(account.credential.email === undefined ? {} : { email: account.credential.email }),
      }))
    })
  }

  readActive() {
    return this.#enqueue(async () => {
      const payload = await this.#ensurePayload()
      const active = payload?.accounts.find(account => account.id === payload.activeId)
      return active?.enabled === false ? undefined : clone(active?.credential)
    })
  }

  read(id) {
    return this.#enqueue(async () => {
      const payload = await this.#ensurePayload()
      return clone(payload?.accounts.find(account => account.id === id)?.credential)
    })
  }

  scheduler() {
    return this.#enqueue(async () => normalizeScheduler((await this.#ensurePayload())?.scheduler))
  }

  updateScheduler(patch = {}) {
    return this.#enqueue(async () => {
      const strategy = patch.strategy
      const sessionAffinity = patch.sessionAffinity
      if (strategy !== undefined && !SCHEDULER_STRATEGIES.has(strategy)) throw new Error('Unsupported Codex scheduling strategy')
      if (sessionAffinity !== undefined && typeof sessionAffinity !== 'boolean') throw new Error('Invalid Codex session affinity setting')
      const payload = await this.#modifyPayload(current => ({
        ...current,
        scheduler: normalizeScheduler({ ...current.scheduler, ...patch }),
      }))
      return normalizeScheduler(payload.scheduler)
    })
  }

  configure(id, patch = {}) {
    return this.#enqueue(async () => {
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new Error('Invalid Codex account enabled state')
      if (patch.priority !== undefined && normalizePriority(patch.priority) !== patch.priority) throw new Error('Invalid Codex account priority')
      if (patch.weight !== undefined && normalizeWeight(patch.weight) !== patch.weight) throw new Error('Invalid Codex account weight')
      const payload = await this.#modifyPayload(current => {
        const index = current.accounts.findIndex(account => account.id === id)
        if (index < 0) throw new Error('Unknown Codex account')
        const accounts = [...current.accounts]
        accounts[index] = {
          ...accounts[index],
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.priority === undefined ? {} : { priority: patch.priority }),
          ...(patch.weight === undefined ? {} : { weight: patch.weight }),
        }
        const activeId = accounts.find(account => account.id === current.activeId)?.enabled === false
          ? accounts.find(account => account.enabled !== false)?.id ?? current.activeId
          : current.activeId
        return { ...current, activeId, accounts }
      })
      return payload.accounts.map(account => ({
        id: account.id,
        label: account.label,
        active: account.id === payload.activeId,
        ...(account.enabled === false ? { enabled: false } : {}),
        ...(normalizePriority(account.priority) === 0 ? {} : { priority: normalizePriority(account.priority) }),
        ...(normalizeWeight(account.weight) === 1 ? {} : { weight: normalizeWeight(account.weight) }),
        expiresAt: account.credential.expires,
        ...(account.credential.email === undefined ? {} : { email: account.credential.email }),
      }))
    })
  }

  activeId() {
    return this.#enqueue(async () => (await this.#ensurePayload())?.activeId)
  }

  add(label, credential) {
    return this.#enqueue(async () => {
      const normalizedLabel = normalizeLabel(label)
      const validated = sanitizeOAuthCredential(credential)
      await this.#ensurePayload()
      const id = this.createId()
      const payload = await this.#modifyPayload(current => ({
        ...current,
        activeId: id,
        accounts: [...current.accounts, { id, label: normalizedLabel, credential: validated, enabled: true, priority: 0, weight: 1 }],
      }))
      const account = payload.accounts.find(candidate => candidate.id === id)
      return {
        id,
        label: account.label,
        active: true,
        expiresAt: account.credential.expires,
        ...(account.credential.email === undefined ? {} : { email: account.credential.email }),
      }
    })
  }

  importMany(entries) {
    return this.#enqueue(async () => {
      if (!Array.isArray(entries) || entries.length === 0) throw new Error('No Codex accounts to import')
      const validated = entries.map((entry, index) => {
        const credential = sanitizeOAuthCredential(entry?.credential)
        const fallback = credential.email ?? `Account ${index + 1}`
        return { label: normalizeLabel(entry?.label ?? fallback), credential }
      })

      const merge = source => {
        const accounts = source.map(account => clone(account))
        let added = 0
        let updated = 0
        let duplicates = 0
        for (const entry of validated) {
          const index = matchingAccountIndex(accounts, entry.credential)
          if (index >= 0) {
            const current = accounts[index]
            if (sameOAuthCredential(current.credential, entry.credential)) {
              duplicates += 1
              continue
            }
            // Re-importing the same OpenAI account refreshes only its OAuth
            // credential. Local scheduling metadata and the stable vault id stay put.
            accounts[index] = { ...current, credential: entry.credential }
            updated += 1
            continue
          }
          accounts.push({
            id: this.createId(),
            label: entry.label,
            credential: entry.credential,
            enabled: true,
            priority: 0,
            weight: 1,
          })
          added += 1
        }
        return { accounts, added, updated, duplicates }
      }

      const existing = await this.#ensurePayload()
      if (existing === undefined) {
        const merged = merge([])
        if (merged.accounts.length === 0) throw new Error('No new Codex accounts to import')
        const created = await this.credentials.modifyRecord(this.key, current => {
          if (current !== undefined) return Promise.resolve(current)
          return Promise.resolve(grant({
            version: VERSION,
            activeId: merged.accounts[0].id,
            accounts: merged.accounts,
            scheduler: normalizeScheduler(),
          }))
        })
        const payload = assertVaultRecord(created)
        return {
          added: merged.added,
          updated: merged.updated,
          duplicates: merged.duplicates,
          total: payload.accounts.length,
        }
      }

      let summary
      const payload = await this.#modifyPayload(current => {
        summary = merge(current.accounts)
        if (summary.added === 0 && summary.updated === 0) return current
        return { ...current, accounts: summary.accounts }
      })
      return {
        added: summary.added,
        updated: summary.updated,
        duplicates: summary.duplicates,
        total: payload.accounts.length,
      }
    })
  }

  select(id) {
    return this.#enqueue(async () => {
      await this.#modifyPayload(current => {
        const account = current.accounts.find(account => account.id === id)
        if (account === undefined) throw new Error('Unknown Codex account')
        if (account.enabled === false) throw new Error('Cannot select a disabled Codex account')
        return { ...current, activeId: id }
      })
    })
  }

  modify(id, update) {
    return this.#enqueue(async () => {
      const existing = await this.#ensurePayload()
      if (existing === undefined) throw new Error('Codex account vault is not signed in')
      let result
      await this.#modifyPayload(async current => {
        const index = current.accounts.findIndex(account => account.id === id)
        if (index < 0) throw new Error('Unknown Codex account')
        const previous = clone(current.accounts[index].credential)
        const next = await update(previous)
        if (next === undefined) {
          result = previous
          return current
        }
        const credential = sanitizeOAuthCredential(next)
        if (credential.email === undefined && previous.email !== undefined) credential.email = previous.email
        const accounts = [...current.accounts]
        accounts[index] = { ...accounts[index], credential }
        result = clone(credential)
        return { ...current, accounts }
      })
      return result
    })
  }

  modifyActive(update) {
    return this.#enqueue(async () => {
      const existing = await this.#ensurePayload()
      if (existing === undefined) {
        const initial = await update(undefined)
        if (initial === undefined) return undefined
        const credential = sanitizeOAuthCredential(initial)
        await this.credentials.set(this.legacyRef, JSON.stringify(credential))
        await this.#ensurePayload()
        return clone(credential)
      }
      let result
      await this.#modifyPayload(async current => {
        const index = current.accounts.findIndex(account => account.id === current.activeId)
        const previous = clone(current.accounts[index].credential)
        const next = await update(previous)
        if (next === undefined) {
          result = previous
          return current
        }
        const credential = sanitizeOAuthCredential(next)
        if (credential.email === undefined && previous.email !== undefined) credential.email = previous.email
        const accounts = [...current.accounts]
        accounts[index] = { ...accounts[index], credential }
        result = clone(credential)
        return { ...current, accounts }
      })
      return result
    })
  }

  deleteAll() {
    return this.#enqueue(async () => {
      await this.credentials.deleteRecord(this.key)
      await this.credentials.unset(this.legacyRef)
      for (const ref of this.legacyRefs) await this.credentials.unset(ref)
    })
  }

  remove(id) {
    return this.#enqueue(async () => {
      await this.#modifyPayload(current => {
        if (!current.accounts.some(account => account.id === id)) throw new Error('Unknown Codex account')
        if (current.accounts.length === 1) throw new Error('Cannot remove the last account; sign out instead')
        const accounts = current.accounts.filter(account => account.id !== id)
        const next = {
          ...current,
          activeId: current.activeId === id ? accounts[0].id : current.activeId,
          accounts,
        }
        if (current.legacyAccountId === id) delete next.legacyAccountId
        return next
      })
    })
  }
}
