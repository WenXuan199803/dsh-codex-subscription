import { parseAccountImport } from './account-import.js'
import { assertCodexAuthUrl } from './external-url.js'

const LOGIN_METHODS = new Set(['browser', 'device_code'])
const TERMINAL_PHASES = new Set(['authenticated', 'failed', 'cancelled'])

const publicClone = value => structuredClone(value)
const asObject = value => value !== null && typeof value === 'object' ? value : {}
const ok = value => ({ ok: true, value })
const badRequest = message => ({
  ok: false,
  error: { code: 'bad-request', message, details: { issues: [] } },
})
const accountStatusError = message => ({
  ok: false,
  error: { code: 'internal', message, details: { issues: [] } },
})

const classifyAccountStatusError = error => {
  const message = error instanceof Error ? error.message : ''
  if (/malformed (?:OAuth|grant|account vault)|received a malformed OAuth|contains malformed OAuth/iu.test(message)) {
    return ['credential-malformed', 'Codex account credentials are malformed']
  }
  if (/credential|account vault|readRecord|credential store|credentials service/iu.test(message)) {
    return ['credential-unavailable', 'Codex account credentials are unavailable']
  }
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : ''
  if (error?.name === 'TimeoutError' || ['TIMEOUT', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return ['transport', 'Codex account status service is unavailable']
  }
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'NETWORK', 'NETWORK_ERROR', 'TRANSPORT'].includes(code)
    || error?.name === 'NetworkError') {
    return ['transport', 'Codex account status service is unavailable']
  }
  return ['unknown', 'Could not read Codex account status']
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const publicPrompt = prompt => ({
  type: prompt.type,
  message: String(prompt.message ?? ''),
  ...(typeof prompt.placeholder === 'string' ? { placeholder: prompt.placeholder } : {}),
})

function classifyLoginFailure(error) {
  const message = error instanceof Error ? error.message : ''
  if (/token exchange failed/iu.test(message)) return 'token-exchange'
  if (/fetch failed|\b(?:ECONN|ENOTFOUND|ETIMEDOUT|CERT_|socket|network)\b/iu.test(message)) return 'network'
  if (/extract accountId|account[_ -]?id/iu.test(message)) return 'account-claim'
  if (/credential|credentials-local|OAuth JSON/iu.test(message)) return 'credential-store'
  if (/Missing authorization code|State mismatch|callback/iu.test(message)) return 'callback'
  return 'provider'
}

/** Own one host-side login without exposing tokens to the browser client. */
export class CodexLoginCoordinator {
  #sessions = new Map()
  #activeId

  constructor(auth, options = {}) {
    this.auth = auth
    this.createId = options.createId ?? (() => crypto.randomUUID())
    this.accountVault = options.accountVault
    this.scheduler = options.scheduler
    this.getSchedulerConfig = options.getSchedulerConfig ?? (() => this.accountVault?.scheduler?.())
    this.updateSchedulerConfig = options.updateSchedulerConfig ?? (patch => this.accountVault?.updateScheduler?.(patch))
  }

  async accountStatus(options) {
    return publicClone(await this.auth.status(options))
  }

  supportState() {
    const active = this.#activeId === undefined ? undefined : this.#sessions.get(this.#activeId)
    if (active === undefined) return { phase: 'idle' }
    return {
      method: active.view.method,
      phase: active.view.phase,
      ...(active.view.phase === 'failed' ? { failure: classifyLoginFailure(active.hostError) } : {}),
    }
  }

  async start({ method, label }) {
    if (!LOGIN_METHODS.has(method)) throw new Error(`unsupported Codex login method: ${String(method)}`)
    if (label !== undefined && (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > 48)) {
      throw new Error('unsupported Codex account label')
    }
    const active = this.#activeId === undefined ? undefined : this.#sessions.get(this.#activeId)
    if (active !== undefined && !TERMINAL_PHASES.has(active.view.phase)) {
      active.view = {
        id: active.view.id,
        provider: 'openai-codex',
        method: active.view.method,
        phase: 'cancelled',
        authenticated: false,
      }
      active.controller.abort(new Error('Codex login replaced by a new attempt'))
    }
    if (active !== undefined) this.#sessions.delete(active.view.id)

    const id = this.createId()
    const ready = deferred()
    const controller = new AbortController()
    const session = {
      controller,
      prompt: undefined,
      ready,
      view: {
        id,
        provider: 'openai-codex',
        method,
        phase: 'starting',
        authenticated: false,
      },
    }
    this.#sessions.set(id, session)
    this.#activeId = id

    const publishReady = () => ready.resolve(publicClone(session.view))
    const interaction = {
      signal: controller.signal,
      prompt: async prompt => {
        controller.signal.throwIfAborted()
        if (prompt.type === 'select') return method
        if (!['manual_code', 'text', 'secret'].includes(prompt.type)) {
          throw new Error(`unsupported Codex auth prompt: ${String(prompt.type)}`)
        }
        const answer = deferred()
        session.prompt = answer
        session.view = {
          ...session.view,
          phase: 'waiting_input',
          prompt: publicPrompt(prompt),
        }
        const abortPrompt = () => answer.reject(controller.signal.reason ?? new Error('login cancelled'))
        controller.signal.addEventListener('abort', abortPrompt, { once: true })
        prompt.signal?.addEventListener('abort', abortPrompt, { once: true })
        publishReady()
        try {
          return await answer.promise
        } finally {
          controller.signal.removeEventListener('abort', abortPrompt)
          prompt.signal?.removeEventListener('abort', abortPrompt)
          if (session.prompt === answer) session.prompt = undefined
        }
      },
      notify: event => {
        if (controller.signal.aborted) return
        if (event.type === 'auth_url') {
          session.view = {
            ...session.view,
            phase: 'waiting_browser',
            authUrl: assertCodexAuthUrl(event.url),
            ...(typeof event.instructions === 'string' ? { instructions: event.instructions } : {}),
          }
        } else if (event.type === 'device_code') {
          session.view = {
            ...session.view,
            phase: 'waiting_device',
            deviceCode: {
              userCode: event.userCode,
              verificationUri: assertCodexAuthUrl(event.verificationUri),
              ...(typeof event.intervalSeconds === 'number' ? { intervalSeconds: event.intervalSeconds } : {}),
              ...(typeof event.expiresInSeconds === 'number' ? { expiresInSeconds: event.expiresInSeconds } : {}),
            },
          }
        } else {
          session.view = { ...session.view, message: String(event.message ?? '') }
        }
        publishReady()
      },
    }

    session.run = Promise.resolve()
      .then(() => this.auth.login(interaction, label === undefined ? {} : { label: label.trim() }))
      .then(async () => {
        if (controller.signal.aborted) return
        const status = await this.auth.status()
        session.view = {
          id,
          provider: 'openai-codex',
          method,
          phase: 'authenticated',
          authenticated: status.authenticated === true,
          ...(typeof status.expiresAt === 'number' ? { expiresAt: status.expiresAt } : {}),
        }
      })
      .catch(async error => {
        if (controller.signal.aborted) {
          session.view = {
            id,
            provider: 'openai-codex',
            method,
            phase: 'cancelled',
            authenticated: false,
          }
          return
        }
        try {
          if (label !== undefined) throw error
          const status = await this.auth.status()
          if (status.authenticated === true) {
            session.view = {
              id,
              provider: 'openai-codex',
              method,
              phase: 'authenticated',
              authenticated: true,
              ...(typeof status.expiresAt === 'number' ? { expiresAt: status.expiresAt } : {}),
            }
            return
          }
        } catch {
          // Preserve the provider failure when credential state cannot be read.
        }
        session.view = {
          id,
          provider: 'openai-codex',
          method,
          phase: 'failed',
          authenticated: false,
          error: 'Codex login failed',
        }
        // Provider errors may contain credentials. Keep the diagnostic host-only.
        session.hostError = error
      })
      .finally(publishReady)

    return ready.promise
  }

  read(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new Error('unknown Codex login')
    return publicClone(session.view)
  }

  async submit({ id, value }) {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new Error('unknown Codex login')
    if (session.prompt === undefined || session.view.phase !== 'waiting_input') {
      throw new Error('Codex login is not waiting for input')
    }
    if (typeof value !== 'string' || value.trim() === '') throw new Error('Codex login input is empty')
    const answer = session.prompt
    session.prompt = undefined
    session.view = {
      ...session.view,
      phase: session.view.authUrl === undefined ? 'starting' : 'waiting_browser',
      prompt: undefined,
    }
    answer.resolve(value)
    return this.read(id)
  }

  async cancel(id) {
    const session = this.#sessions.get(id)
    if (session === undefined) throw new Error('unknown Codex login')
    if (!TERMINAL_PHASES.has(session.view.phase)) {
      session.view = {
        id,
        provider: 'openai-codex',
        method: session.view.method,
        phase: 'cancelled',
        authenticated: false,
      }
      session.controller.abort(new Error('Codex login cancelled'))
    }
    return this.read(id)
  }

  async logout(options) {
    if (this.#activeId !== undefined) {
      const active = this.#sessions.get(this.#activeId)
      if (active !== undefined && !TERMINAL_PHASES.has(active.view.phase)) await this.cancel(active.view.id)
    }
    await this.auth.logout(options)
    return this.accountStatus(options)
  }

  async selectAccount(id) {
    return publicClone(await this.auth.select(id))
  }

  async removeAccount(id) {
    return publicClone(await this.auth.remove(id))
  }

  async importAccounts(input) {
    if (this.accountVault === undefined) throw new Error('Codex multi-account is unavailable')
    const entries = parseAccountImport(input)
    const result = await this.accountVault.importMany(entries)
    return { ...result, account: await this.accountStatus() }
  }

  async configureAccount(id, patch) {
    if (this.accountVault === undefined) throw new Error('Codex multi-account is unavailable')
    await this.accountVault.configure(id, patch)
    return this.accountStatus()
  }

  async schedulerStatus() {
    if (this.accountVault === undefined) throw new Error('Codex multi-account is unavailable')
    return {
      config: await this.getSchedulerConfig(),
      accounts: await this.accountVault.list(),
      runtime: this.scheduler?.snapshot?.() ?? { bindings: 0, cooldowns: [] },
    }
  }

  async updateScheduler(patch) {
    if (this.accountVault === undefined) throw new Error('Codex multi-account is unavailable')
    if (patch.strategy !== undefined && !['fill-first', 'round-robin', 'weighted-round-robin'].includes(patch.strategy)) {
      throw new Error('Unsupported Codex scheduling strategy')
    }
    if (patch.sessionAffinity !== undefined && typeof patch.sessionAffinity !== 'boolean') {
      throw new Error('Invalid Codex scheduler affinity')
    }
    if (Object.hasOwn(patch, 'fixedAccountId') && patch.fixedAccountId !== null
      && (typeof patch.fixedAccountId !== 'string' || patch.fixedAccountId.length === 0)) {
      throw new Error('Invalid Codex fixed account')
    }
    await this.updateSchedulerConfig(patch)
    return this.schedulerStatus()
  }
}

/** Map the loopback-only DSH Connection channel onto the coordinator. */
export function createCodexRpcHandler(coordinator, options = {}) {
  const openExternal = options.openExternal
  return async (endpoint, payload, signal) => {
    try {
      signal.throwIfAborted()
      const input = asObject(payload)
      if (endpoint === 'status') {
        try {
          return ok(await coordinator.accountStatus({ signal }))
        } catch (error) {
          if (signal.aborted) throw error
          const [, message] = classifyAccountStatusError(error)
          return accountStatusError(message)
        }
      }
      if (endpoint === 'login/start') {
        const started = await coordinator.start({ method: input.method, label: input.label })
        if (input.openExternal !== true) return ok(started)
        const url = started.authUrl ?? started.deviceCode?.verificationUri
        if (typeof url !== 'string' || openExternal === undefined) {
          return ok({ ...started, externalOpened: false })
        }
        try {
          await openExternal(url)
          return ok({ ...started, externalOpened: true })
        } catch {
          return ok({ ...started, externalOpened: false })
        }
      }
      if (endpoint === 'login/status') return ok(coordinator.read(input.id))
      if (endpoint === 'login/submit') return ok(await coordinator.submit({ id: input.id, value: input.value }))
      if (endpoint === 'login/cancel') return ok(await coordinator.cancel(input.id))
      if (endpoint === 'logout') return ok(await coordinator.logout({ signal }))
      if (endpoint === 'account/select') return ok(await coordinator.selectAccount(input.id))
      if (endpoint === 'account/remove') return ok(await coordinator.removeAccount(input.id))
      if (endpoint === 'account/import') return ok(await coordinator.importAccounts({ name: input.name, encoded: input.encoded }))
      if (endpoint === 'account/configure') return ok(await coordinator.configureAccount(input.id, {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.weight === undefined ? {} : { weight: input.weight }),
      }))
      if (endpoint === 'scheduler/status') return ok(await coordinator.schedulerStatus())
      if (endpoint === 'scheduler/update') return ok(await coordinator.updateScheduler({
        ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
        ...(input.sessionAffinity === undefined ? {} : { sessionAffinity: input.sessionAffinity }),
        ...(Object.hasOwn(input, 'fixedAccountId') ? { fixedAccountId: input.fixedAccountId } : {}),
      }))
      return badRequest(`unknown Codex auth endpoint: ${endpoint}`)
    } catch (error) {
      if (signal.aborted) throw error
      // Never reflect provider errors; even bad requests get a bounded message.
      const safe = /^(unknown|unsupported|a Codex|Codex login|No Codex|No new Codex|Import |Invalid ZIP|Truncated ZIP|Unsupported ZIP|Encrypted ZIP|Codex account|Invalid Codex|Unsupported Codex)/u
      const message = error instanceof Error && safe.test(error.message)
        ? error.message
        : 'Codex request failed'
      return badRequest(message)
    }
  }
}

export const createCodexAuthRpcHandler = createCodexRpcHandler
