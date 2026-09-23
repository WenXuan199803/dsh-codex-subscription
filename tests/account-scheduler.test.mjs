import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexAccountScheduler, ScheduledCodexAdapter, classifyFailure } from '../src/account-scheduler.js'

function vault(config = { strategy: 'fill-first', sessionAffinity: true }) {
  const accounts = [
    { id: 'a', label: 'A', active: true, expiresAt: 1_900_000_000_000 },
    { id: 'b', label: 'B', active: false, expiresAt: 1_900_000_000_000 },
    { id: 'c', label: 'C', active: false, expiresAt: 1_900_000_000_000 },
  ]
  return {
    async list() { return accounts.map(account => ({ ...account })) },
    async scheduler() { return { ...config } },
    async activeId() { return 'a' },
  }
}

test('classifies quota and overload failures for account failover', () => {
  assert.deepEqual(classifyFailure({ code: 'PI_AI_ERROR', message: 'Encountered invalidated oauth token for user, failing request' }), {
    retryable: true, reason: 'auth', cooldownMs: 60_000,
  })
  assert.equal(classifyFailure({ status: 429, message: 'usage_limit_reached resets_in_seconds: 120' }).reason, 'quota')
  assert.equal(classifyFailure({ status: 503, message: 'server_is_overloaded' }).reason, 'transient')
  assert.equal(classifyFailure({ status: 400, message: 'bad request' }).retryable, false)
  assert.equal(classifyFailure({ status: 400, message: 'model gpt-6-sol is not available for this account' }).reason, 'model-access')
  assert.equal(classifyFailure({ code: 'MODEL_ACCESS_DENIED' }).retryable, true)
})

test('model resolution waits for the catalog after a bulk import', async () => {
  let available = false
  const catalog = { async ensure() { available = true }, async ready() { available = true } }
  const base = {
    async resolveModel(_provider, model) {
      if (!available) throw new Error(`no configured model ${model}`)
      return { id: model }
    },
    async prepareCall(_provider, model) {
      if (!available) throw new Error(`no configured model ${model}`)
      return { model: { id: model }, stream: async function* () {} }
    },
  }
  const adapter = new ScheduledCodexAdapter(base, undefined, undefined, catalog)
  assert.equal((await adapter.resolveModel('openai-codex', 'gpt-6-sol')).id, 'gpt-6-sol')
  available = false
  assert.equal((await adapter.prepareCall('openai-codex', 'gpt-6-sol')).model.id, 'gpt-6-sol')
})

test('fill-first keeps one account until it cools down, then advances', async () => {
  let now = 10_000
  const scheduler = new CodexAccountScheduler(vault(), { now: () => now })
  assert.equal((await scheduler.choose('s1')).id, 'a')
  scheduler.markFailure('a', { status: 503, message: 'server_is_overloaded' })
  assert.equal((await scheduler.choose('s1')).id, 'b')
  assert.equal((await scheduler.choose('s1')).id, 'b')
  now += 11_000
  assert.equal((await scheduler.choose('s2')).id, 'b', 'fill-first keeps the healthy current account after cooldown expiry')
})

test('round-robin without affinity rotates accounts', async () => {
  const scheduler = new CodexAccountScheduler(vault({ strategy: 'round-robin', sessionAffinity: false }))
  assert.deepEqual([
    (await scheduler.choose()).id,
    (await scheduler.choose()).id,
    (await scheduler.choose()).id,
    (await scheduler.choose()).id,
  ], ['a', 'b', 'c', 'a'])
})

test('weighted round-robin honors account weights when affinity is off', async () => {
  const weightedVault = vault({ strategy: 'weighted-round-robin', sessionAffinity: false })
  const originalList = weightedVault.list
  weightedVault.list = async () => (await originalList()).map(account => ({
    ...account,
    weight: account.id === 'a' ? 2 : 1,
  }))
  const scheduler = new CodexAccountScheduler(weightedVault)
  assert.deepEqual([
    (await scheduler.choose()).id,
    (await scheduler.choose()).id,
    (await scheduler.choose()).id,
    (await scheduler.choose()).id,
  ], ['a', 'a', 'b', 'c'])
})

test('fixed account mode ignores normal rotation and never falls through to another account', async () => {
  const selected = []
  const fixedVault = vault({ strategy: 'round-robin', sessionAffinity: false, fixedAccountId: 'b' })
  const scheduler = new CodexAccountScheduler(fixedVault)
  assert.equal((await scheduler.choose('one')).id, 'b')
  assert.equal((await scheduler.choose('two')).id, 'b')

  const store = {
    current: undefined,
    withAccount(id, operation) {
      const previous = this.current
      this.current = id
      try {
        const value = operation()
        if (value && typeof value.then === 'function') return value.finally(() => { this.current = previous })
        this.current = previous
        return value
      } catch (error) {
        this.current = previous
        throw error
      }
    },
  }
  const base = {
    providerInfo(provider) { return { id: provider, name: provider } },
    providerRetryPolicy() { return undefined },
    imageRequestPricing() { return undefined },
    async listModels() { return [] },
    async resolveModel(provider, model) { return { provider, id: model, name: model } },
    async *stream() {
      selected.push(store.current)
      yield { type: 'finish', reason: { kind: 'error', failure: { status: 503, code: 'SERVER_OVERLOADED', message: 'server_is_overloaded' } } }
    },
  }
  const adapter = new ScheduledCodexAdapter(base, scheduler, store)
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-test', messages: [], sessionId: 'fixed-test' })) chunks.push(chunk)
  assert.deepEqual(selected, ['b'])
  assert.match(chunks.at(-1)?.reason?.failure?.message ?? '', /server_is_overloaded/u)
  assert.equal((await scheduler.choose('another')).id, 'b', 'fixed testing bypasses cross-request cooldown')
})

test('scheduled adapter hides a pre-output failure and continues on the next account', async () => {
  const selected = []
  const store = {
    current: undefined,
    withAccount(id, operation) {
      const previous = this.current
      this.current = id
      try {
        const value = operation()
        if (value && typeof value.then === 'function') {
          return value.finally(() => { this.current = previous })
        }
        this.current = previous
        return value
      } catch (error) {
        this.current = previous
        throw error
      }
    },
  }
  const base = {
    providerInfo(provider) { return { id: provider, name: provider } },
    providerRetryPolicy() { return undefined },
    imageRequestPricing() { return undefined },
    async listModels() { return [] },
    async resolveModel(provider, model) { return { provider, id: model, name: model } },
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
    },
    async *stream() {
      const id = store.current
      selected.push(id)
      if (id === 'a') {
        yield { type: 'finish', reason: { kind: 'error', failure: { status: 503, code: 'SERVER_OVERLOADED', message: 'server_is_overloaded' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `hello-${id}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `hello-${id}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const scheduler = new CodexAccountScheduler(vault())
  const adapter = new ScheduledCodexAdapter(base, scheduler, store)
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-test', messages: [], sessionId: 'session-1' })) {
    chunks.push(chunk)
  }
  assert.deepEqual(selected, ['a', 'b'])
  assert.equal(chunks.some(chunk => chunk.reason?.failure?.message === 'server_is_overloaded'), false)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'hello-b')

  selected.length = 0
  for await (const _ of adapter.stream({ provider: 'openai-codex', model: 'gpt-test', messages: [], sessionId: 'session-1' })) {}
  assert.deepEqual(selected, ['b'], 'the session remains pinned to the replacement account')
})
