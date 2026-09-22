import { randomUUID } from 'node:crypto'

const VERSION = 1
const DEFAULT_LABEL = 'Account 1'
const clone = value => value === undefined ? undefined : structuredClone(value)
const EMAIL_MAX_LENGTH = 254
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

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
    legacyAccountId,
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
    if (existing !== undefined) return assertVaultRecord(existing)
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
        enabled: account.enabled !== false,
        priority: normalizePriority(account.priority),
        weight: normalizeWeight(account.weight),
        expiresAt: account.credential.expires,
        ...(account.credential.email === undefined ? {} : { email: account.credential.email }),
      }))
    })
  }

  readActive() {
    return this.#enqueue(async () => {
      const payload = await this.#ensurePayload()
      return clone(payload?.accounts.find(account => account.id === payload.activeId)?.credential)
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
        return { ...current, accounts }
      })
      return payload.accounts.map(account => ({
        id: account.id,
        label: account.label,
        active: account.id === payload.activeId,
        enabled: account.enabled !== false,
        priority: normalizePriority(account.priority),
        weight: normalizeWeight(account.weight),
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
      const existing = await this.#ensurePayload()
      if (existing === undefined) {
        const seenRefresh = new Set()
        const seenAccess = new Set()
        const accounts = []
        let duplicates = 0
        for (const entry of validated) {
          if (seenRefresh.has(entry.credential.refresh) || seenAccess.has(entry.credential.access)) {
            duplicates += 1
            continue
          }
          const id = this.createId()
          accounts.push({ id, label: entry.label, credential: entry.credential, enabled: true, priority: 0, weight: 1 })
          seenRefresh.add(entry.credential.refresh)
          seenAccess.add(entry.credential.access)
        }
        if (accounts.length === 0) throw new Error('No new Codex accounts to import')
        const created = await this.credentials.modifyRecord(this.key, current => {
          if (current !== undefined) return Promise.resolve(current)
          return Promise.resolve(grant({
            version: VERSION,
            activeId: accounts[0].id,
            accounts,
            scheduler: normalizeScheduler(),
          }))
        })
        const payload = assertVaultRecord(created)
        return { added: payload.accounts.length, duplicates, total: payload.accounts.length }
      }

      let added = 0
      let duplicates = 0
      const payload = await this.#modifyPayload(current => {
        const refreshTokens = new Set(current.accounts.map(account => account.credential.refresh))
        const accessTokens = new Set(current.accounts.map(account => account.credential.access))
        const accounts = [...current.accounts]
        for (const entry of validated) {
          if (refreshTokens.has(entry.credential.refresh) || accessTokens.has(entry.credential.access)) {
            duplicates += 1
            continue
          }
          const id = this.createId()
          accounts.push({ id, label: entry.label, credential: entry.credential, enabled: true, priority: 0, weight: 1 })
          refreshTokens.add(entry.credential.refresh)
          accessTokens.add(entry.credential.access)
          added += 1
        }
        return added === 0 ? current : { ...current, accounts }
      })
      return { added, duplicates, total: payload.accounts.length }
    })
  }

  select(id) {
    return this.#enqueue(async () => {
      await this.#modifyPayload(current => {
        if (!current.accounts.some(account => account.id === id)) throw new Error('Unknown Codex account')
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
        return {
          ...current,
          activeId: current.activeId === id ? accounts[0].id : current.activeId,
          legacyAccountId: current.legacyAccountId === id ? undefined : current.legacyAccountId,
          accounts,
        }
      })
    })
  }
}
