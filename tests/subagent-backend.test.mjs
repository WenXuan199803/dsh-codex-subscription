import test from 'node:test'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSubagentTokens } from '../src/subagent-auth.js'
import { createSubscriptionSubagent, createSubagentBackendSwitcher, SUBAGENT_PROVIDER, subagentThreadPolicy } from '../src/subagent-backend.js'
import { CodexAccountScheduler } from '../src/account-scheduler.js'

test('subscription subagent pins account and serializes concurrent token rotation', async () => {
  let current = { type: 'oauth', accountId: 'a', access: 'old' }
  let rotations = 0
  let tail = Promise.resolve()
  const store = { read: async () => current, modify: (_, fn) => {
    const next = tail.then(async () => current = await fn(current)); tail = next.catch(() => {}); return next
  } }
  const tokens = await createSubagentTokens({ store, resolveAuth: async () => {}, signal: new AbortController().signal,
    refresh: async value => { rotations++; return { ...value, access: 'new' } } })
  const results = await Promise.all([tokens('a'), tokens('a')])
  assert.equal(rotations, 1)
  assert.deepEqual(results[0], { accessToken: 'new', chatgptAccountId: 'a' })
  current = { ...current, accountId: 'b' }
  await assert.rejects(tokens(), /authorization failed/)
  await assert.rejects(tokens('b'), /authorization failed/)
})

test('native subagent authentication chooses B when A fails before the child starts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-subagent-pool-'))
  const scope = new AsyncLocalStorage(), selected = []
  const store = {
    withAccount: (id, operation) => scope.run(id, operation),
    async read() { const id = scope.getStore(); return { type: 'oauth', accountId: id, access: `access-${id}` } },
    async modify() { throw new Error('not needed') },
  }
  const scheduler = new CodexAccountScheduler({
    async list() { return [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    async scheduler() { return { strategy: 'fill-first', sessionAffinity: true } },
    async activeId() { return 'a' },
  })
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } }
  const instance = createSubscriptionSubagent({
    ctx, nativeHome: home, scheduler, store,
    async resolveAuth() {
      selected.push(scope.getStore())
      if (scope.getStore() === 'a') throw new Error('Codex subscription authorization failed')
      return { auth: { apiKey: 'access-b' } }
    },
    async refresh() { throw new Error('not needed') },
    async loadRuntime() { return { Transport: class {}, official: { apply(host) {
      host.subagents.registerProvider({ async start() { return { result: Promise.resolve({ kind: 'completed' }), async dispose() {} } } })
    } } } },
  })
  try {
    const run = await instance.provider.start({
      signal: new AbortController().signal,
      parent: { session: { id: 'parent-session', requestHeader: () => ({ config: { provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'high' } }) } },
    })
    assert.deepEqual(selected, ['a', 'b'])
    assert.deepEqual(await run.result, { kind: 'completed' })
  } finally { instance.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('subagent policy takes parent model effort and sandbox, never user Codex defaults', () => {
  assert.deepEqual(subagentThreadPolicy({ session: { requestHeader: () => ({ config: {
    provider: 'openai-codex', model: 'gpt-5.6-luna', reasoningEffort: 'max',
  } }) } }, { mode: 'read-only' }), {
    model: 'gpt-5.6-luna', modelProvider: 'openai', approvalPolicy: 'never', sandbox: 'read-only',
    config: { model_reasoning_effort: 'max' },
  })
  assert.throws(() => subagentThreadPolicy({}, {}), /sandbox/)
})

function entry(provider, extra = {}) {
  return { options: { name: '@deepseek-ai/dsh-tool-subagent' }, fiber: {
    config: { provider, ...extra }, async update(value, transient) { assert.equal(transient, true); this.config = value },
  } }
}
test('explicit child route overrides inheritance without silently changing effort or permissions', () => {
  const parent = { session: { requestHeader: () => ({config: {provider:'openai-codex',model:'gpt-6-astra',reasoningEffort:'ultra'}}) } }
  const policy = {mode:'read-only'}
  const chosen = subagentThreadPolicy(parent, policy, {provider:'openai-codex',model:'gpt-5.6-luna',reasoningEffort:'low'})
  assert.equal(chosen.model, 'gpt-5.6-luna')
  assert.equal(chosen.config.model_reasoning_effort, 'low')
  assert.equal(chosen.sandbox, 'read-only')
  assert.deepEqual(subagentThreadPolicy(parent,policy,{model:'gpt-5.6-luna'}).config,{})
  const other = {session:{requestHeader:()=>({config:{provider:'deepseek',model:'deepseek'}})}}
  assert.throws(()=>subagentThreadPolicy(other,policy), /Select an openai-codex model/)
  assert.equal(subagentThreadPolicy(other,policy,{provider:'openai-codex',model:'gpt-5.6-luna'}).model,'gpt-5.6-luna')
  assert.throws(()=>subagentThreadPolicy(parent,policy,{provider:'deepseek',model:'deepseek'}), /require the openai-codex/)
  assert.throws(()=>subagentThreadPolicy(parent,policy,{sandbox:'danger-full-access'}), /Unsupported Codex child option/)
})
test('backend switches independent tool and restores it without changing fork or custom tools', async () => {
  const spawn = entry('spawn'), fork = entry('fork'), custom = entry('spawn', { persona: 'custom' })
  const switcher = createSubagentBackendSwitcher({ entries: () => [spawn, fork, custom], prepare: async () => {} })
  await switcher.select('codex')
  assert.equal(spawn.fiber.config.provider, SUBAGENT_PROVIDER)
  assert.equal(spawn.fiber.config.modelSelectionSettings, true)
  assert.equal(fork.fiber.config.provider, 'fork')
  assert.equal(custom.fiber.config.provider, 'spawn')
  await switcher.select('dsh')
  assert.deepEqual(spawn.fiber.config, { provider: 'spawn' })
  await switcher.select('codex')
  await switcher.dispose()
  assert.deepEqual(spawn.fiber.config, { provider: 'spawn' })
  await assert.rejects(switcher.select('codex'), /unavailable/)
})
test('failed persistence restores tool configuration', async () => {
  const spawn = entry('spawn')
  const switcher = createSubagentBackendSwitcher({ entries: () => [spawn], prepare: async () => {}, persist: async () => { throw Error('disk') } })
  await assert.rejects(switcher.select('codex'), /disk/)
  assert.deepEqual(spawn.fiber.config, { provider: 'spawn' })
})

test('web preset tools mounted after selection receive the chosen backend', async () => {
  const dormant = { options: { name: '@deepseek-ai/dsh-tool-subagent', disabled: true, config: { provider: 'spawn' } } }
  const switcher = createSubagentBackendSwitcher({ entries: () => [dormant], prepare: async () => {} })
  await switcher.select('codex')
  const mounted = entry('spawn', { toolName: 'subagent' })
  mounted.fiber.entry = mounted
  mounted.fiber.config = switcher.configure(mounted.fiber, mounted.fiber.config)
  assert.equal(mounted.fiber.config.provider, SUBAGENT_PROVIDER)
  await switcher.select('dsh')
  assert.equal(mounted.fiber.config.provider, 'spawn')
  await switcher.dispose()
})
