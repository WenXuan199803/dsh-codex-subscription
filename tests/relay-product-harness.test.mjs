import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { isSafeShellQuery } from '../src/tool-step-recovery.js'

const { apply } = await import(process.env.CODEX_TEST_PLUGIN_ENTRY
  ? pathToFileURL(process.env.CODEX_TEST_PLUGIN_ENTRY).href
  : '../src/index.js')

const jwt = id => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.fixture`
const event = value => `data: ${JSON.stringify(value)}\n\n`
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const completed = (id, model = 'gpt-5.6-luna') => [
  { type: 'response.created', response: { id: `response-${id}`, model } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `message-${id}`, role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: `ok-${id}` },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `message-${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `ok-${id}`, annotations: [] }] } },
  { type: 'response.done', response: { id: `response-${id}`, model, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
]

function host(state) {
  const routes = new Map(), records = state.records ?? new Map(), watchers = new Set()
  const searchProviders = new Map()
  const tools = []
  const saves = []
  const toolHooks = []
  let settings = state.settings ?? { accountSchedulerStrategy: 'fill-first', accountSchedulerSessionAffinity: true, connectionMode: 'sse' }
  let adapter
  const ctx = {
    credentials: {
      async resolve() { return undefined }, async set() {}, async unset() {},
      async readRecord(key) { return structuredClone(records.get(key)) },
      async modifyRecord(key, mutate) {
        const next = await mutate(structuredClone(records.get(key)))
        if (next !== undefined) records.set(key, structuredClone(next))
        return structuredClone(records.get(key))
      },
      async deleteRecord(key) { records.delete(key) },
    },
    settings: { writable: true, register() { return {
      get: () => settings,
      async update(patch) { const old = settings; settings = { ...settings, ...patch }; for (const watch of watchers) await watch(settings, old) },
      watch(callback) { watchers.add(callback); return () => watchers.delete(callback) },
    } } },
    llm: { registerAdapter(_providers, value) { adapter = value; return () => {} } },
    attachments: { imageLimits: { maxImageBytes: 10_000_000, maxMessageImageBytes: 10_000_000, mediaTypes: ['image/png'] },
      async saveImage(input) { saves.push(input); return { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 68, width: 1, height: 1, name: 'fixture.png' } },
      async readImageRequest(ref) { return { ...ref, data: Buffer.from(pixel, 'base64'), mediaType: 'image/png' } },
    },
    tools: { register(tool) { tools.push(tool); return () => { const index = tools.indexOf(tool); if (index >= 0) tools.splice(index, 1) } } },
    web: { searchProviders, registerSearchProvider(provider) { searchProviders.set(provider.id, provider); return () => searchProviders.delete(provider.id) } },
    connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } },
    loader: { *entries() { yield { options: { id: 'web', config: {} }, fiber: { config: {}, async update() {} } } }, await: async () => {} },
    inject(services, callback) { if (services.every(service => ctx[service] !== undefined)) callback(ctx) },
    on(event, callback) { if (event === 'tools/execute') toolHooks.push(callback); return () => {} },
    get(name) { return name === 'attachments' ? ctx.attachments : undefined }, effect(register) { return register() },
  }
  apply(ctx)
  const rpc = async (name, payload = {}) => {
    const method = `codex-subscription/${name}`
    const route = routes.get(`/api/${method}`)
    assert.ok(route, `missing real RPC route ${method}`)
    const response = await route.fetch(new Request(`http://localhost${route.path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `${name}-fixture`, method, payload }),
    }))
    const envelope = await response.json()
    assert.equal(envelope.result?.ok, true, JSON.stringify(envelope))
    return envelope.result.value
  }
  return {
    ctx, rpc, records, searchProviders, tools, saves, toolHooks, get adapter() { return adapter },
    restart() { return host({ records, settings }) },
  }
}

async function fixture(t, scenario) {
  const previousHome = process.env.DSH_HOME
  const localHome = mkdtempSync(join(tmpdir(), 'codex-relay-harness-'))
  process.env.DSH_HOME = localHome
  t.after(() => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; rmSync(localHome, { recursive: true, force: true }) })
  const server = http.createServer(async (request, reply) => {
    const pieces = []
    for await (const piece of request) pieces.push(piece)
    const bytes = Buffer.concat(pieces)
    const body = request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes).toString() : bytes.toString()
    const account = request.headers['chatgpt-account-id']
    let parsedBody
    try { parsedBody = body ? JSON.parse(body) : undefined } catch { parsedBody = body }
    scenario.requests.push({ account, path: request.url, body: parsedBody, headers: request.headers })
    if (request.url.endsWith('/oauth/token')) {
      const outcome = await scenario.authRespond?.(parsedBody) ?? { status: 400, body: { error: 'invalid_grant' } }
      reply.writeHead(outcome.status, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(outcome.body))
      return
    }
    if (request.url.includes('/models')) {
      reply.writeHead(200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify({ models: scenario.models ?? [] }))
      return
    }
    if (request.url.endsWith('/search')) {
      const outcome = scenario.searchRespond?.(account) ?? {}
      if (outcome.disconnect === 'during') {
        reply.writeHead(200, { 'content-type': 'application/json' })
        reply.write('{"results":[')
        setImmediate(() => reply.destroy())
        return
      }
      reply.writeHead(outcome.status ?? 200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(outcome.status ? { error: { code: 'server_is_overloaded' } } : { results: [{ url: `https://example.test/${account}`, title: account }] }))
      return
    }
    if (request.url.endsWith('/images/generations')) {
      const outcome = scenario.imageRespond?.(account) ?? {}
      if (outcome.disconnect === 'during') {
        reply.writeHead(200, { 'content-type': 'application/json' })
        reply.write('{"data":[')
        setImmediate(() => reply.destroy())
        return
      }
      reply.writeHead(outcome.status ?? 200, { 'content-type': 'application/json' })
      reply.end(JSON.stringify(outcome.status ? { error: { code: 'server_is_overloaded' } }
        : outcome.incomplete ? { created: 1, data: [] }
        : { created: 1, ...(outcome.reportedModel ? { model: outcome.reportedModel } : {}), background: 'opaque', quality: 'medium', size: '1024x1024', data: [{ b64_json: pixel }] }))
      return
    }
    const outcome = await scenario.respond(account, scenario.requests.filter(item => item.path.includes('/responses')).length, parsedBody)
    if (outcome.disconnect === 'before') { reply.destroy(); return }
    if (outcome.status) {
      reply.writeHead(outcome.status, { 'content-type': 'application/json' })
      reply.end(JSON.stringify({ error: {
        code: outcome.code ?? 'server_is_overloaded', message: outcome.message ?? 'server_is_overloaded',
        ...(outcome.resetsInSeconds === undefined ? {} : { type: 'usage_limit_reached', resets_in_seconds: outcome.resetsInSeconds }),
      } }))
      return
    }
    reply.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const item of outcome.events ?? completed(account)) reply.write(event(item))
    if (outcome.disconnect === 'during') { reply.destroy(); return }
    reply.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const original = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
    const account = new Headers(init?.headers).get('chatgpt-account-id')
    const fault = scenario.transportFault?.(target, account)
    if (fault) {
      scenario.transportAttempts ??= []
      scenario.transportAttempts.push({ account, path: target.pathname, code: fault.code })
      return Promise.reject(Object.assign(new Error(fault.message ?? `Network transport failure (${fault.code})`), { code: fault.code }))
    }
    return original(`http://127.0.0.1:${server.address().port}${target.pathname}`, init)
  }
  t.after(async () => { globalThis.fetch = original; await new Promise(resolve => server.close(resolve)) })
  return host({})
}

async function addAccounts(product, names = ['a', 'b']) {
  const accounts = names.map(id => ({ label: id, access_token: jwt(id), refresh_token: `refresh-${id}`, expires_at: Date.now() + 86_400_000, account_id: id }))
  await product.rpc('account/import', { name: 'fixture.json', encoded: Buffer.from(JSON.stringify(accounts)).toString('base64') })
  return (await product.rpc('scheduler/status')).accounts
}

async function run(product, sessionId = 'same-session', extra = {}) {
  const chunks = []
  const options = {
    provider: 'openai-codex', model: 'gpt-5.6-luna', sessionId,
    signal: AbortSignal.timeout(10000),
    systemPrompt: 'Keep the plan',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Finish task step two' }] }],
    ...extra,
  }
  const prepared = await product.adapter.prepareCall(options.provider, options.model, options.signal)
  for await (const chunk of prepared.stream(options)) chunks.push(chunk)
  return chunks
}

test('product RPC persists round robin and the actual request follows it after restart', async t => {
  const scenario = { requests: [], respond: () => ({}) }
  let product = await fixture(t, scenario)
  await addAccounts(product)
  await product.rpc('scheduler/update', { strategy: 'round-robin', sessionAffinity: false })
  product = product.restart()
  for (let n = 0; n < 8; n++) assert.equal((await run(product, `session-${n}`)).find(chunk => chunk.type === 'text-delta')?.text.startsWith('ok-'), true)
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a', 'b', 'a', 'b', 'a', 'b', 'a', 'b'])
})

test('product failover preserves canonical request after a pre-output 503', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { status: 503 } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b', JSON.stringify(chunks))
  const requests = scenario.requests.filter(item => item.path.includes('/responses'))
  assert.deepEqual(requests.map(item => item.account), ['a', 'b'])
  assert.deepEqual(requests[0].body, requests[1].body)
  const diagnostics = (await product.rpc('scheduler/status')).runtime.relayEvents
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics.at(-1)?.reason, 'transient')
  assert.equal(chunks.some(chunk => JSON.stringify(chunk).includes('账号接力')), false)
})

test('A and B receive identical model, effort, prompts, tool schema, image and session history', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { status: 503 } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const attachment = { attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png', bytes: Buffer.from(pixel, 'base64').length, width: 1, height: 1, name: '示例 图片.png' }
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Step one is complete; continue step two' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'openai-codex', model: 'gpt-5.6-luna' }, content: [{ type: 'text', text: 'Step one completed' }] },
    { role: 'user', content: [{ type: 'text', text: 'Use the attached image and tool' }, { type: 'image', attachment }] },
  ]
  const chunks = await run(product, 'rich-session', {
    system: 'Preserve the original plan and the completed first step.', reasoningEffort: 'high',
    tools: [{ name: 'inspect_fixture', description: 'Inspect the fixture once', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
    messages,
  })
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
  const attempts = scenario.requests.filter(item => item.path.includes('/responses'))
  assert.deepEqual(attempts.map(item => item.account), ['a', 'b'])
  assert.deepEqual(attempts[0].body, attempts[1].body)
  assert.equal(attempts[1].body.model, 'gpt-5.6-luna')
  assert.equal(attempts[1].body.reasoning.effort, 'high')
  assert.equal(attempts[1].body.instructions, 'Preserve the original plan and the completed first step.')
  assert.equal(attempts[1].body.tools[0].name, 'inspect_fixture')
  assert.match(JSON.stringify(attempts[1].body.input), /Step one completed/u)
  assert.match(JSON.stringify(attempts[1].body.input), /image\/png/u)
})

test('empty output item before a 200 in-stream overload still relays', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { events: [
    { type: 'response.created', response: { id: 'first' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'empty', role: 'assistant', content: [] } },
    { type: 'response.failed', response: { id: 'first', status: 'failed', error: { code: 'server_is_overloaded', message: 'server_is_overloaded' } } },
  ] } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b', JSON.stringify(chunks))
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a', 'b'])
})

test('CPA-style HTTP 200 in-stream selected-model capacity error relays', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { events: [
    { type: 'response.created', response: { id: 'capacity' } },
    { type: 'response.failed', response: { id: 'capacity', status: 'failed', error: { code: 'model_at_capacity', message: 'Selected model is at capacity' } } },
  ] } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b', JSON.stringify(chunks))
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a', 'b'])
})

test('HTTP 200 SSE terminal error shapes relay account-scoped failures', async t => {
  const failures = [
    { type: 'response.failed', response: { status: 'failed', error: { code: 'usage_limit_reached', message: 'usage_limit_reached resets_in_seconds: 120' } } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'invalid_token', message: 'invalidated oauth token' } } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'model_not_found', message: 'model gpt-5.6-luna is not available for this account' } } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'timeout', message: 'WebSocket response idle timeout' } } },
    { type: 'error', code: 'rate_limit_exceeded', message: 'rate limit exceeded' },
  ]
  for (let index = 0; index < failures.length; index++) await t.test(`SSE shape ${index}`, async subtest => {
    const scenario = { requests: [], respond: account => account === 'a' ? { events: [
      { type: 'response.created', response: { id: 'failed' } }, failures[index],
    ] } : {} }
    const product = await fixture(subtest, scenario)
    await addAccounts(product)
    const chunks = await run(product)
    assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b', JSON.stringify(chunks))
  })
})

test('five-hour and weekly quota exhaustion cool only A for the requested model', async t => {
  for (const [label, seconds] of [['five-hour', 3600], ['weekly', 604800]]) await t.test(label, async subtest => {
    const scenario = { requests: [], respond: account => account === 'a' ? {
      status: 429, code: 'usage_limit_reached', message: `usage_limit_reached ${label}`, resetsInSeconds: seconds,
    } : {} }
    const product = await fixture(subtest, scenario)
    const accounts = await addAccounts(product)
    const chunks = await run(product)
    assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b')
    const state = (await product.rpc('scheduler/status')).runtime.cooldowns
    assert.equal(state.length, 1)
    assert.equal(state[0].id, accounts.find(item => item.label === 'a').id)
    assert.equal(state[0].model, 'gpt-5.6-luna')
    assert.ok(state[0].remainingMs > (seconds - 2) * 1000, JSON.stringify({ state, chunks }))
  })
})

test('HTTP 200 response.failed keeps structured weekly reset timing through pi-ai', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { events: [
    { type: 'response.created', response: { id: 'weekly' } },
    { type: 'response.failed', response: { id: 'weekly', status: 'failed', error: { type: 'usage_limit_reached', code: 'usage_limit_reached', message: 'usage limit reached', resets_in_seconds: 604800 } } },
  ] } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b')
  const state = (await product.rpc('scheduler/status')).runtime.cooldowns
  assert.equal(state.length, 1)
  assert.ok(state[0].remainingMs > 604_798_000, JSON.stringify(state))
})

test('failed OAuth refresh for A relays the same request to B', async t => {
  const scenario = { requests: [], respond: () => ({}) }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const entry = [...product.records].find(([, record]) => record?.payload?.accounts)
  assert.ok(entry)
  const [key, raw] = entry
  const record = structuredClone(raw)
  record.payload.accounts.find(account => account.label === 'a').credential.expires = Date.now() - 60_000
  product.records.set(key, record)
  const chunks = await run(product)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b', JSON.stringify(chunks))
  assert.ok(scenario.requests.some(item => item.path.endsWith('/oauth/token')))
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['b'])
})

test('concurrent turns share one A token refresh and all keep their task requests', async t => {
  let refreshes = 0
  const scenario = { requests: [], respond: () => ({}), async authRespond() {
    refreshes++
    return { status: 200, body: { access_token: jwt('a'), refresh_token: 'rotated-a', expires_in: 3600 } }
  } }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const entry = [...product.records].find(([, record]) => record?.payload?.accounts)
  const [key, raw] = entry, record = structuredClone(raw)
  record.payload.accounts.find(account => account.label === 'a').credential.expires = Date.now() - 60_000
  product.records.set(key, record)
  const turns = await Promise.all(Array.from({ length: 8 }, (_, index) => run(product, `refresh-parallel-${index}`)))
  assert.equal(refreshes, 1)
  assert.equal(turns.filter(chunks => chunks.at(-1)?.reason?.kind === 'stop').length, 8)
  assert.equal(scenario.requests.filter(item => item.path.includes('/responses')).length, 8)
})

test('twelve concurrent sessions retain request identity while one shared account fails', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { status: 503 } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  await product.rpc('scheduler/update', { strategy: 'round-robin', sessionAffinity: true })
  const turns = await Promise.all(Array.from({ length: 12 }, (_, index) => run(product, `parallel-${index}`)))
  for (const chunks of turns) {
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 1)
  }
  const bySession = new Map()
  for (const request of scenario.requests.filter(item => item.path.includes('/responses'))) {
    const id = request.headers['session-id']
    const group = bySession.get(id) ?? []
    group.push(request)
    bySession.set(id, group)
  }
  assert.equal(bySession.size, 12)
  assert.equal([...bySession.values()].filter(group => group.length === 2).length, 6)
  for (const group of bySession.values()) {
    assert.equal(group.at(-1).account, 'b')
    if (group.length === 2) assert.deepEqual(group[0].body, group[1].body)
  }
})

test('UI import and disable during an in-flight request reroute it to the newly eligible account', async t => {
  let markStarted, releaseFailure
  const started = new Promise(resolve => { markStarted = resolve })
  const failureGate = new Promise(resolve => { releaseFailure = resolve })
  const scenario = { requests: [], async respond(account) {
    if (account === 'a') { markStarted(); await failureGate; return { status: 503 } }
    return {}
  } }
  const product = await fixture(t, scenario)
  const initial = await addAccounts(product)
  const pending = run(product, 'dynamic-pool')
  await started
  const afterImport = await addAccounts(product, ['c'])
  const b = initial.find(item => item.label === 'b'), c = afterImport.find(item => item.label === 'c')
  await product.rpc('account/configure', { id: b.id, enabled: false })
  await product.rpc('account/configure', { id: c.id, priority: 5 })
  releaseFailure()
  const chunks = await pending
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-c')
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a', 'c'])
})

test('all exhausted accounts return a bounded diagnostic chain only at terminal failure', async t => {
  const scenario = { requests: [], respond: () => ({ status: 429, code: 'usage_limit_reached', message: 'usage_limit_reached resets_in_seconds: 300' }) }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.equal(chunks.at(-1)?.reason?.kind, 'error')
  assert.match(chunks.at(-1).reason.failure.message, /账号接力.*a.*b/u)
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), false)
  assert.equal(scenario.requests.filter(item => item.path.includes('/responses')).length, 2)
})

test('mid-text stream failure must not leak partial output or terminate while B can complete', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { events: [
    { type: 'response.created', response: { id: 'first' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'partial', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial A' },
    { type: 'response.failed', response: { id: 'first', status: 'failed', error: { code: 'server_is_overloaded', message: 'server_is_overloaded' } } },
  ] } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['ok-b'])
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a', 'b'])
})

test('every pre-finish SSE boundary may fail without committing partial DSH output or tools', async t => {
  const created = { type: 'response.created', response: { id: 'boundary' } }
  const emptyText = { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'partial', role: 'assistant', content: [] } }
  const toolStart = { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc-boundary', call_id: 'call-boundary', name: 'write', arguments: '' } }
  const failure = { type: 'response.failed', response: { id: 'boundary', status: 'failed', error: { code: 'server_is_overloaded', message: 'server_is_overloaded' } } }
  const boundaries = [
    ['created', [created]],
    ['in_progress', [created, { type: 'response.in_progress', response: { id: 'boundary' } }]],
    ['empty output item', [created, emptyText]],
    ['reasoning start', [created, { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'thinking', summary: [] } }]],
    ['first token', [created, emptyText, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'first' }]],
    ['mid text', [created, emptyText, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'first' }, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'second' }]],
    ['tool construction', [created, toolStart, { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path"' }]],
    ['tool complete before finish', [created, toolStart, { type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"path":"file"}' }, { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc-boundary', call_id: 'call-boundary', name: 'write', arguments: '{"path":"file"}' } }]],
  ]
  for (const [name, prefix] of boundaries) await t.test(name, async subtest => {
    const scenario = { requests: [], respond: account => account === 'a' ? { events: [...prefix, failure] } : {} }
    const product = await fixture(subtest, scenario)
    await addAccounts(product)
    const chunks = await run(product, `boundary-${name}`)
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['ok-b'], JSON.stringify(chunks))
    assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'), false)
    assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a', 'b'])
  })
})

test('a completed response is committed once even if an invalid late frame follows', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { events: [
    ...completed('a'),
    { type: 'response.failed', response: { id: 'late', status: 'failed', error: { code: 'server_is_overloaded', message: 'too late' } } },
  ] } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['ok-a'])
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a'])
})

test('upstream model substitution is rejected before output and relays to the requested model', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { events: [
    { type: 'response.created', response: { id: 'wrong-model', model: 'gpt-5.6-sol' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'wrong-message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'wrong-model-output' },
    { type: 'response.done', response: { id: 'wrong-model', model: 'gpt-5.6-sol', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ] } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['ok-b'])
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a', 'b'])
})

test('requested Astra and Sol are never silently downgraded during failover', async t => {
  for (const [requested, wrong] of [['gpt-6-astra', 'gpt-6-sol'], ['gpt-5.6-sol', 'gpt-5.6-luna']]) await t.test(requested, async subtest => {
    const scenario = { requests: [], models: [requested, 'gpt-5.6-luna'].map(slug => ({
      slug, display_name: slug, visibility: 'list', context_window: 272000,
      supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort })),
    })), respond: account => ({ events: completed(account, account === 'a' ? wrong : requested) }) }
    const product = await fixture(subtest, scenario)
    await addAccounts(product)
    await product.adapter.resolveModel('openai-codex', requested)
    const chunks = await run(product, `model-${requested}`, { model: requested })
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['ok-b'], JSON.stringify({ chunks, requests: scenario.requests.filter(item => item.path.includes('/responses')) }))
    const wires = scenario.requests.filter(item => item.path.includes('/responses'))
    assert.deepEqual(wires.map(item => item.account), ['a', 'b'])
    assert.deepEqual(wires.map(item => item.body.model), [requested, requested])
  })
})

test('a short provider-wide overload retries the same task after the first account round', async t => {
  const scenario = { requests: [], respond: (_account, requestNumber) => requestNumber <= 2 ? { status: 503 } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.startsWith('ok-')))
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop')
  assert.equal(scenario.requests.filter(item => item.path.includes('/responses')).length, 3)
})

test('a provider outage spanning three credential rounds recovers without a new user message', async t => {
  const scenario = { requests: [], respond: (_account, requestNumber) => requestNumber <= 8 ? { status: 503 } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const chunks = await run(product)
  assert.equal(chunks.at(-1)?.reason?.kind, 'stop', JSON.stringify(chunks))
  assert.equal(scenario.requests.filter(item => item.path.includes('/responses')).length, 9)
})

test('HTTP account and transient failure matrix relays without changing the request', async t => {
  const cases = [
    ...[401, 403, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]
      .map(status => ({ status })),
    { status: 400, code: 'model_not_found', message: 'model gpt-5.6-luna is not available for this account' },
    { status: 404, code: 'model_not_found', message: 'model gpt-5.6-luna not found for this account' },
  ]
  for (const failure of cases) await t.test(`HTTP ${failure.status} ${failure.code ?? ''}`, async subtest => {
    const scenario = { requests: [], respond: account => account === 'a' ? failure : {} }
    const product = await fixture(subtest, scenario)
    await addAccounts(product)
    const chunks = await run(product)
    assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b', JSON.stringify(chunks))
    const requests = scenario.requests.filter(item => item.path.includes('/responses'))
    assert.deepEqual(requests.map(item => item.account), ['a', 'b'])
    assert.deepEqual(requests[0].body, requests[1].body)
  })
})

test('request errors stop before exhausting the account pool', async t => {
  for (const status of [400, 404]) await t.test(`HTTP ${status}`, async subtest => {
    const scenario = { requests: [], respond: () => ({ status, code: 'invalid_request', message: 'Invalid request payload' }) }
    const product = await fixture(subtest, scenario)
    await addAccounts(product)
    const chunks = await run(product)
    assert.equal(chunks.at(-1)?.reason?.kind, 'error')
    assert.equal(scenario.requests.filter(item => item.path.includes('/responses')).length, 1)
  })
})

test('connection reset before headers and after the first token both relay', async t => {
  for (const disconnect of ['before', 'during']) await t.test(disconnect, async subtest => {
    const scenario = { requests: [], respond: account => account === 'a'
      ? { disconnect, events: [
        { type: 'response.created', response: { id: 'cut' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'cut', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' },
      ] } : {} }
    const product = await fixture(subtest, scenario)
    await addAccounts(product)
    const chunks = await run(product)
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['ok-b'], JSON.stringify(chunks))
  })
})

test('real adapter request path relays typed DNS, TLS, connect, EOF and idle transport faults', async t => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'EOF']) {
    await t.test(code, async subtest => {
      const scenario = { requests: [], respond: () => ({}), transportFault: (target, account) =>
        target.pathname.endsWith('/responses') && account === 'a' ? { code } : undefined }
      const product = await fixture(subtest, scenario)
      await addAccounts(product)
      const chunks = await run(product)
      assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok-b', JSON.stringify(chunks))
      assert.deepEqual(scenario.transportAttempts.map(item => item.account), ['a'])
      assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['b'])
    })
  }
})

test('UI RPC weight, priority, enable switch and affinity control real request distribution', async t => {
  const scenario = { requests: [], respond: () => ({}) }
  const product = await fixture(t, scenario)
  const accounts = await addAccounts(product)
  const a = accounts.find(item => item.label === 'a'), b = accounts.find(item => item.label === 'b')
  await product.rpc('account/configure', { id: a.id, weight: 3 })
  await product.rpc('scheduler/update', { strategy: 'weighted-round-robin', sessionAffinity: false })
  for (let n = 0; n < 40; n++) await run(product, `weighted-${n}`)
  const weighted = scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account)
  assert.equal(weighted.filter(id => id === 'a').length, 30)
  assert.equal(weighted.filter(id => id === 'b').length, 10)

  scenario.requests.length = 0
  await product.rpc('account/configure', { id: b.id, priority: 2 })
  for (let n = 0; n < 10; n++) await run(product, `priority-${n}`)
  assert.deepEqual(new Set(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account)), new Set(['b']))

  scenario.requests.length = 0
  await product.rpc('account/configure', { id: b.id, enabled: false })
  for (let n = 0; n < 4; n++) await run(product, `disabled-${n}`)
  assert.deepEqual(new Set(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account)), new Set(['a']))

  await product.rpc('account/configure', { id: b.id, enabled: true, priority: 0 })
  await product.rpc('scheduler/update', { strategy: 'round-robin', sessionAffinity: true })
  scenario.requests.length = 0
  await run(product, 'sticky-a'); await run(product, 'sticky-a'); await run(product, 'sticky-b')
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a', 'a', 'b'])
})

test('fixed diagnostic mode uses only selected account and persists after restart', async t => {
  const scenario = { requests: [], respond: account => account === 'a' ? { status: 503 } : {} }
  let product = await fixture(t, scenario)
  const accounts = await addAccounts(product)
  await product.rpc('scheduler/update', { fixedAccountId: accounts.find(item => item.label === 'a').id })
  product = product.restart()
  const chunks = await run(product)
  assert.equal(chunks.at(-1)?.reason?.kind, 'error')
  assert.deepEqual(scenario.requests.filter(item => item.path.includes('/responses')).map(item => item.account), ['a'])
})

test('completed side effects remain once across relays at 20, 50 and 80 percent', async t => {
  const toolEvents = (step, fail) => {
    const id = `call-${step}`, args = JSON.stringify({ step })
    return [
      { type: 'response.created', response: { id: `response-${step}`, model: 'gpt-5.6-luna' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: `fc-${step}`, call_id: id, name: 'record_step', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: args.slice(0, 4) },
      ...(fail ? [{ type: 'response.failed', response: { id: `response-${step}`, status: 'failed', error: { code: 'server_is_overloaded', message: 'server_is_overloaded' } } }] : [
        { type: 'response.function_call_arguments.done', output_index: 0, arguments: args },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: `fc-${step}`, call_id: id, name: 'record_step', arguments: args } },
        { type: 'response.done', response: { id: `response-${step}`, model: 'gpt-5.6-luna', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      ]),
    ]
  }
  const injected = new Set(), effects = []
  let step = 1
  const scenario = { requests: [], respond: () => {
    const fail = [2, 5, 8].includes(step) && !injected.has(step)
    if (fail) injected.add(step)
    return { events: toolEvents(step, fail) }
  } }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  await product.rpc('scheduler/update', { strategy: 'round-robin', sessionAffinity: false })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Execute steps one through ten once, in order' }] }]
  for (step = 1; step <= 10; step++) {
    const chunks = await run(product, 'long-task', { messages })
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')?.block
    assert.ok(call, `turn ${step}: ${JSON.stringify(chunks)}`)
    assert.ok(call.id.startsWith(`call-${step}`))
    const input = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    assert.equal(input.step, step)
    effects.push(input.step)
    messages.push({ role: 'assistant', source: { kind: 'model', provider: 'openai-codex', model: 'gpt-5.6-luna' }, content: [call] })
    messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: `effect-${step}-done` }], isError: false }] })
  }
  assert.deepEqual(effects, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual([...injected], [2, 5, 8])
  for (const failedStep of injected) {
    const wire = scenario.requests.filter(item => item.path.includes('/responses') && item.body.input.some(input => JSON.stringify(input).includes(`effect-${failedStep - 1}-done`)))
    assert.ok(wire.length >= 2, `missing failover wire at step ${failedStep}`)
    assert.deepEqual(wire[0].body, wire[1].body)
  }
})

test('Codex search uses the account pool when its active credential gets HTTP 503', async t => {
  const scenario = { requests: [], respond: () => ({}), searchRespond: account => account === 'a' ? { status: 503 } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const provider = product.searchProviders.get('codex-subscription')
  assert.ok(provider)
  const result = await provider.search({ query: 'fixture' }, AbortSignal.timeout(3000))
  assert.equal(result.sources[0].title, 'b')
  assert.deepEqual(scenario.requests.filter(item => item.path.endsWith('/search')).map(item => item.account), ['a', 'b'])
})

test('Codex search also waits through a short provider-wide outage across account rounds', async t => {
  let requests = 0
  const scenario = { requests: [], respond: () => ({}), searchRespond: () => ++requests <= 8 ? { status: 503 } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const result = await product.searchProviders.get('codex-subscription').search({ query: 'fixture' }, AbortSignal.timeout(10000))
  assert.equal(result.sources.length, 1)
  assert.equal(requests, 9)
})

test('search stream interruption returns a complete B result, not partial A JSON', async t => {
  const scenario = { requests: [], respond: () => ({}), searchRespond: account => account === 'a' ? { disconnect: 'during' } : {} }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const result = await product.searchProviders.get('codex-subscription').search({ query: 'fixture' }, AbortSignal.timeout(3000))
  assert.equal(result.sources[0].title, 'b')
  assert.deepEqual(scenario.requests.filter(item => item.path.endsWith('/search')).map(item => item.account), ['a', 'b'])
})

test('Codex image generation relays 401, 429 and 503 before saving one final artifact', async t => {
  for (const status of [401, 429, 503]) await t.test(`image HTTP ${status}`, async subtest => {
    const scenario = { requests: [], respond: () => ({}), imageRespond: account => account === 'a' ? { status } : {} }
    const product = await fixture(subtest, scenario)
    await addAccounts(product)
    const tool = product.tools.find(item => item.name === 'codex_generate_image') ?? product.tools.find(item => item.name?.includes('image'))
    assert.ok(tool, product.tools.map(item => item.name).join(','))
    const result = await tool.execute({ prompt: 'one blue pixel' }, {
      callId: 'image-once', signal: AbortSignal.timeout(3000), agent: { id: 'image-session' },
    })
    assert.equal(result.image.mediaType, 'image/png')
    assert.deepEqual(scenario.requests.filter(item => item.path.endsWith('/images/generations')).map(item => item.account), ['a', 'b'])
    assert.equal(product.saves.length, 1)
  })
})

test('incomplete image JSON and disconnected image stream are retried before artifact creation', async t => {
  for (const failure of [{ disconnect: 'during' }, { incomplete: true }]) await t.test(JSON.stringify(failure), async subtest => {
    const scenario = { requests: [], respond: () => ({}), imageRespond: account => account === 'a' ? failure : {} }
    const product = await fixture(subtest, scenario)
    await addAccounts(product)
    const tool = product.tools.find(item => item.name?.includes('image'))
    const result = await tool.execute({ prompt: 'one blue pixel' }, {
      callId: 'image-complete-only', signal: AbortSignal.timeout(3000), agent: { id: 'image-session' },
    })
    assert.equal(result.image.mediaType, 'image/png')
    assert.deepEqual(scenario.requests.filter(item => item.path.endsWith('/images/generations')).map(item => item.account), ['a', 'b'])
    assert.equal(product.saves.length, 1)
  })
})

test('image model substitution is rejected before saving any A artifact', async t => {
  const scenario = { requests: [], respond: () => ({}), imageRespond: account => account === 'a' ? { reportedModel: 'gpt-image-1' } : { reportedModel: 'gpt-image-2' } }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const tool = product.tools.find(item => item.name?.includes('image'))
  const result = await tool.execute({ prompt: 'one blue pixel' }, {
    callId: 'image-model-guard', signal: AbortSignal.timeout(3000), agent: { id: 'image-session' },
  })
  assert.equal(result.reportedModel, 'gpt-image-2')
  assert.equal(product.saves.length, 1)
  assert.deepEqual(scenario.requests.filter(item => item.path.endsWith('/images/generations')).map(item => item.account), ['a', 'b'])
})

test('DSH ToolRuntime commits only completed read-only tool results after interrupted bodies', async t => {
  const product = await fixture(t, { requests: [], respond: () => ({}) })
  const ctx = new Context()
  ctx.systemPrompt = { tools() {} }
  const runtime = new ToolRuntime(ctx)
  product.ctx.tools = runtime
  for (const hook of product.toolHooks) ctx.on('tools/execute', hook)
  const audits = new Map()
  ctx.on('tools/execute', async (exec, next) => {
    audits.set(exec.name, (audits.get(exec.name) ?? 0) + 1)
    return next()
  })
  const attempts = new Map()
  for (const [name, code] of [['web_search', 'WEB_PROVIDER_ERROR'], ['web_fetch', 'WEB_PROVIDER_ERROR'], ['read', 'EIO'], ['bash', 'EIO']]) {
    runtime.register({
      name, description: 'fixture read-only tool', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute() {
        const count = (attempts.get(name) ?? 0) + 1
        attempts.set(name, count)
        if (count === 1) throw Object.assign(new Error('partial stream without a complete artifact'), { code })
        return { text: `COMPLETE_${name}` }
      },
    })
  }
  const agent = { session: { requestContext: () => ({ provider: 'openai-codex' }) } }
  for (const [name, argumentsValue] of [['web_search', { queries: ['fixture'] }], ['web_fetch', { url: 'https://example.test/page' }], ['read', { filePath: '/tmp/fixture' }], ['bash', { command: 'pwd' }]]) {
    const result = await runtime.execute({ name, arguments: argumentsValue, callId: `tool-${name}`, signal: AbortSignal.timeout(3000), agent })
    assert.equal(result.isError, false, `${name}: ${JSON.stringify({ result, count: attempts.get(name), hooks: product.toolHooks.length })}`)
    assert.equal(result.value.text, `COMPLETE_${name}`)
    assert.equal(attempts.get(name), 2)
    assert.equal(audits.get(name), 2, 'each attempt must traverse every downstream DSH wrapper')
  }
})

test('DSH tool registry leaves uncertain file, Git and message effects for external-state reconciliation', async t => {
  assert.equal(isSafeShellQuery('rg --pre executable pattern'), false)
  assert.equal(isSafeShellQuery('pwd; echo altered > state.txt'), false)
  const product = await fixture(t, { requests: [], respond: () => ({}) })
  const ctx = new Context()
  ctx.systemPrompt = { tools() {} }
  const runtime = new ToolRuntime(ctx)
  product.ctx.tools = runtime
  for (const hook of product.toolHooks) ctx.on('tools/execute', hook)
  const scratch = mkdtempSync(join(tmpdir(), 'codex-relay-effects-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const file = join(scratch, 'committed.txt')
  const repository = join(scratch, 'repo')
  execFileSync('git', ['init', '-q', repository])
  writeFileSync(join(repository, 'state.txt'), 'committed once\n')
  execFileSync('git', ['-C', repository, 'add', 'state.txt'])
  const outbox = new Set(), counts = new Map()
  const effects = [
    ['write', () => writeFileSync(file, 'committed once\n')],
    ['bash', () => execFileSync('git', ['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-q', '-m', 'once'])],
    ['send_message', () => outbox.add('message-once')],
  ]
  for (const [name, effect] of effects) runtime.register({
    name, description: 'uncertain fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute() { counts.set(name, (counts.get(name) ?? 0) + 1); effect(); throw Object.assign(new Error('acknowledgement lost after commit'), { code: 'ECONNRESET' }) },
  })
  const agent = { session: { requestContext: () => ({ provider: 'openai-codex' }) } }
  for (const [name, argumentsValue] of [['write', {}], ['bash', { command: 'git commit -m once' }], ['send_message', {}]]) {
    const result = await runtime.execute({ name, arguments: argumentsValue, callId: `uncertain-${name}`, signal: AbortSignal.timeout(3000), agent })
    assert.equal(result.isError, true)
    assert.equal(counts.get(name), 1)
  }
  // The harness inspects each independent external system before deciding to
  // reuse its already committed result; no second effect is dispatched.
  assert.equal(readFileSync(file, 'utf8'), 'committed once\n')
  assert.equal(execFileSync('git', ['-C', repository, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), 'once')
  assert.deepEqual([...outbox], ['message-once'])
})

test('cloud compaction checkpoint from A is never replayed to B after failover', async t => {
  let turn = 1
  const scenario = { requests: [], respond: account => {
    if (turn === 1) {
      const events = completed(account)
      events.splice(1, 0, { type: 'response.output_item.done', item: { type: 'compaction', encrypted_content: 'fixture-A-private' } })
      events.splice(events.length - 1, 0, { type: 'response.completed', response: { id: 'first', status: 'completed' } })
      return { events }
    }
    return account === 'a' ? { status: 503 } : {}
  } }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  await product.rpc('preferences/update', { compactionMode: 'cloud' })
  const first = await run(product, 'compacted-session')
  const finish = first.at(-1)
  assert.ok(finish.replayState?.response?.codexCompactionV1, JSON.stringify(finish))
  turn = 2
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Finish task step two' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'openai-codex', model: 'gpt-5.6-luna', replayState: finish.replayState }, content: [{ type: 'text', text: 'ok-a' }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue without forgetting the previous turn' }] },
  ]
  const second = await run(product, 'compacted-session', { messages })
  assert.equal(second.at(-1)?.reason?.kind, 'stop')
  const attempts = scenario.requests.filter(item => item.path.includes('/responses') && item.body.input.some(input => JSON.stringify(input).includes('Continue without forgetting')))
  assert.deepEqual(attempts.map(item => item.account), ['a', 'b'])
  assert.equal(attempts[0].body.input.some(input => input.type === 'compaction'), true)
  assert.equal(attempts[1].body.input.some(input => input.type === 'compaction'), false)
  assert.ok(attempts[1].body.input.some(input => JSON.stringify(input).includes('Finish task step two')))
})

test('encrypted reasoning from A is not replayed as B private state while durable task history remains', async t => {
  let turn = 1
  const scenario = { requests: [], respond: account => {
    if (turn === 1) {
      const events = completed(account)
      events.splice(1, 0,
        { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'reason-A', summary: [] } },
        { type: 'response.output_item.done', output_index: 1, item: { type: 'reasoning', id: 'reason-A', encrypted_content: 'A_PRIVATE_REASONING', summary: [] } })
      return { events }
    }
    return account === 'a' ? { status: 503 } : {}
  } }
  const product = await fixture(t, scenario)
  await addAccounts(product)
  const first = await run(product, 'reasoning-session')
  const finish = first.at(-1)
  const content = first.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  assert.ok(finish.replayState?.blocks?.some(block => block.type === 'reasoning'), JSON.stringify(finish))
  turn = 2
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'Finish task step two' }] },
    { role: 'assistant', source: { kind: 'model', provider: 'openai-codex', model: 'gpt-5.6-luna', replayState: finish.replayState }, content },
    { role: 'user', content: [{ type: 'text', text: 'Continue same task after reasoning' }] },
  ]
  const second = await run(product, 'reasoning-session', { messages })
  assert.equal(second.at(-1)?.reason?.kind, 'stop')
  const wires = scenario.requests.filter(item => item.path.includes('/responses') && item.body.input.some(input => JSON.stringify(input).includes('Continue same task')))
  assert.deepEqual(wires.map(item => item.account), ['a', 'b'])
  assert.equal(JSON.stringify(wires[1].body.input).includes('A_PRIVATE_REASONING'), false)
  assert.ok(JSON.stringify(wires[1].body.input).includes('Finish task step two'))
})

test('seeded product chaos: 100 random pools, settings and fault boundaries preserve eligible-account completion', async t => {
  let seed = 0x51a7d02
  const random = maximum => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % maximum }
  const failureEvents = prefix => [
    { type: 'response.created', response: { id: 'failed' } },
    ...prefix,
    { type: 'response.failed', response: { id: 'failed', status: 'failed', error: { code: 'server_is_overloaded', message: 'server_is_overloaded' } } },
  ]
  const faults = [
    () => ({ status: 503 }),
    () => ({ status: 429, code: 'usage_limit_reached', message: 'usage_limit_reached resets_in_seconds: 60' }),
    () => ({ status: 401, code: 'invalid_token', message: 'invalidated oauth token' }),
    () => ({ status: 404, code: 'model_not_found', message: 'model gpt-5.6-luna not found for this account' }),
    () => ({ disconnect: 'before' }),
    () => ({ disconnect: 'during', events: [{ type: 'response.created', response: { id: 'cut' } }] }),
    () => ({ events: failureEvents([{ type: 'response.in_progress', response: { id: 'failed' } }]) }),
    () => ({ events: failureEvents([{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'empty', role: 'assistant', content: [] } }]) }),
    () => ({ events: failureEvents([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'partial', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' },
    ]) }),
    () => ({ events: completed('wrong').map(item => item.response ? { ...item, response: { ...item.response, model: 'gpt-5.6-sol' } } : item) }),
  ]
  for (let iteration = 0; iteration < 100; iteration++) await t.test(`seed 0x51a7d02 case ${iteration}`, async subtest => {
    const names = Array.from({ length: 2 + random(4) }, (_, index) => `pool-${index}`)
    const fault = faults[random(faults.length)]()
    let failed = false
    const scenario = { requests: [], respond: () => {
      if (!failed) { failed = true; return fault }
      return {}
    } }
    const product = await fixture(subtest, scenario)
    const accounts = await addAccounts(product, names)
    const strategies = ['fill-first', 'round-robin', 'weighted-round-robin']
    await product.rpc('scheduler/update', { strategy: strategies[random(strategies.length)], sessionAffinity: random(2) === 0 })
    for (const account of accounts) await product.rpc('account/configure', { id: account.id, weight: 1 + random(5), priority: random(3) })
    const chunks = await run(product, `chaos-${iteration}`)
    assert.equal(chunks.at(-1)?.reason?.kind, 'stop', `case ${iteration}: ${JSON.stringify(chunks)}`)
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').length, 1)
    const attempts = scenario.requests.filter(item => item.path.includes('/responses'))
    assert.equal(attempts.length, 2)
    assert.notEqual(attempts[0].account, attempts[1].account)
    assert.deepEqual(attempts[0].body, attempts[1].body)
  })
})
