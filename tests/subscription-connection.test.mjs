import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createSubscriptionConnection } from '../src/subscription-connection.js'
import { openaiCodexSubscriptionProvider } from '../src/pi-ai-runtime.js'
import { createCodexNetworkTransport, withCodexNetwork } from '../src/oauth-network.js'
import { CodexAccountScheduler, ScheduledCodexAdapter } from '../src/account-scheduler.js'

test('SSE leaves the WebSocket constructor untouched; unrelated WebSocket subclasses retain their prototype', async () => {
  const original = globalThis.WebSocket
  class FixtureSocket { constructor(url) { this.url = url } }
  globalThis.WebSocket = FixtureSocket
  try {
    await withCodexNetwork(async () => assert.equal(globalThis.WebSocket, FixtureSocket))
    await withCodexNetwork(async () => {
      class UnrelatedSocket extends globalThis.WebSocket {}
      const socket = new UnrelatedSocket('wss://example.test/')
      assert.ok(socket instanceof UnrelatedSocket)
      assert.ok(socket instanceof FixtureSocket)
    }, { websocket: true })
    assert.equal(globalThis.WebSocket, FixtureSocket)
  } finally { globalThis.WebSocket = original }
})

test('Codex WebSocket suppresses a wrong-model frame before pi-ai sees it', async () => {
  const original = globalThis.WebSocket
  class FixtureSocket extends EventTarget {
    closed
    close(code, reason) { this.closed = { code, reason } }
  }
  globalThis.WebSocket = FixtureSocket
  const socket = new FixtureSocket(), seen = []
  try {
    await withCodexNetwork(async () => {
      const guarded = new globalThis.WebSocket('wss://chatgpt.com/backend-api/codex/responses')
      guarded.addEventListener('message', event => seen.push(event.data))
      guarded.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { model: 'gpt-5.6-sol' } }) }))
      guarded.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_text.delta', delta: 'wrong' }) }))
    }, { websocket: true, expectedModel: 'gpt-6-astra', createWebSocket: () => socket })
    assert.deepEqual(socket.closed, { code: 1011, reason: 'model_mismatch' })
    assert.deepEqual(seen, [])
  } finally { globalThis.WebSocket = original }
})

test('WebSocket in-stream capacity frame relays through the scheduled DSH adapter', async () => {
  const original = globalThis.WebSocket
  const scope = new AsyncLocalStorage(), requests = []
  const store = { withAccount: (id, operation) => scope.run(id, operation) }
  class ScriptSocket extends EventTarget {
    readyState = 0
    constructor(account) { super(); this.account = account; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }) }
    send(value) {
      const body = JSON.parse(value)
      requests.push({ account: this.account, body })
      const emit = frame => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
      queueMicrotask(() => {
        emit({ type: 'response.created', response: { id: `response-${this.account}`, model: 'gpt-5.6-luna' } })
        if (this.account === 'a') {
          emit({ type: 'response.failed', response: { id: 'response-a', status: 'failed', error: { code: 'model_at_capacity', message: 'Selected model is at capacity' } } })
          return
        }
        emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'message-b', role: 'assistant', content: [] } })
        emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'websocket-b' })
        emit({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'message-b', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'websocket-b', annotations: [] }] } })
        emit({ type: 'response.completed', response: { id: 'response-b', model: 'gpt-5.6-luna', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
      })
    }
    close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; const event = new Event('close'); Object.assign(event, { code, reason, wasClean: code === 1000 }); this.dispatchEvent(event) }
  }
  globalThis.WebSocket = ScriptSocket
  const connection = createSubscriptionConnection({ resolveMode: () => 'websocket', resolveProxy: async () => undefined })
  try {
    const network = createCodexNetworkTransport({ createWebSocket: () => new ScriptSocket(scope.getStore()), platform: 'linux', env: { NO_PROXY: '*' } })
    const provider = openaiCodexSubscriptionProvider({ connection, runNetwork: network.run })
    const profiles = new Map([['openai-codex', { provider: 'openai-codex', displayName: 'Fixture', piProvider: provider, configuredMaxTokens: new Map(), modelErrors: new Map(), transport: 'sse', streamIdleTimeoutMs: 3000 }]])
    const token = account => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.fixture`
    const base = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => token(scope.getStore()) })
    const vault = { async list() { return [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, async scheduler() { return { strategy: 'fill-first', sessionAffinity: true } }, async activeId() { return 'a' } }
    const scheduler = new CodexAccountScheduler(vault)
    const adapter = new ScheduledCodexAdapter(base, scheduler, store)
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'openai-codex', model: 'gpt-5.6-luna', sessionId: 'ws-relay', messages: [{ role: 'user', content: [{ type: 'text', text: 'same task' }] }], signal: AbortSignal.timeout(3000) })) chunks.push(chunk)
    assert.deepEqual(requests.map(item => item.account), ['a', 'b'])
    assert.notEqual(requests[0].body.prompt_cache_key, requests[1].body.prompt_cache_key)
    const { prompt_cache_key: _leftPrivate, ...leftTask } = requests[0].body
    const { prompt_cache_key: _rightPrivate, ...rightTask } = requests[1].body
    assert.deepEqual(leftTask, rightTask)
    assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['websocket-b'])
  } finally { connection.dispose(); globalThis.WebSocket = original }
})

test('WebSocket previous_response continuation stays on A; B starts with full history', async () => {
  const original = globalThis.WebSocket
  const wires = []
  let currentAccount = 'a', sequence = 0
  class ScriptSocket extends EventTarget {
    readyState = 0
    constructor(account) { super(); this.account = account; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }) }
    send(raw) {
      const body = JSON.parse(raw), id = `response-${++sequence}`
      wires.push({ account: this.account, body })
      const emit = frame => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
      queueMicrotask(() => {
        emit({ type: 'response.created', response: { id, model: 'gpt-5.6-luna' } })
        emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: `msg-${sequence}`, role: 'assistant', content: [] } })
        emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: `answer-${sequence}` })
        emit({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: `msg-${sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer-${sequence}`, annotations: [] }] } })
        emit({ type: 'response.completed', response: { id, model: 'gpt-5.6-luna', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
      })
    }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; const event = new Event('close'); Object.assign(event, { code, reason: '', wasClean: true }); this.dispatchEvent(event) }
  }
  globalThis.WebSocket = ScriptSocket
  const connection = createSubscriptionConnection({ resolveMode: () => 'websocket', resolveProxy: async () => undefined })
  const network = createCodexNetworkTransport({ createWebSocket: () => new ScriptSocket(currentAccount), platform: 'linux', env: { NO_PROXY: '*' } })
  const provider = openaiCodexSubscriptionProvider({ connection, runNetwork: network.run })
  const model = provider.getModels().find(item => item.id === 'gpt-5.6-luna')
  const token = account => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.fixture`
  const user = text => ({ role: 'user', content: text, timestamp: 1 })
  const run = async (account, messages) => {
    currentAccount = account
    let done
    for await (const event of provider.streamSimple(model, { messages }, { apiKey: token(account), sessionId: 'shared-dsh-session', signal: AbortSignal.timeout(3000) })) if (event.type === 'done') done = event.message
    assert.ok(done)
    return done
  }
  try {
    const first = await run('a', [user('first')])
    const history = [user('first'), first, user('second')]
    await run('a', history)
    await run('b', history)
    assert.deepEqual(wires.map(item => item.account), ['a', 'a', 'b'])
    assert.ok(wires[1].body.previous_response_id, 'A reused its private continuation')
    assert.equal(wires[2].body.previous_response_id, undefined)
    assert.ok(wires[2].body.input.length > wires[1].body.input.length)
  } finally { connection.dispose(); globalThis.WebSocket = original }
})

test('experimental connections keep default SSE and isolate session caches across credentials, proxies and plugin instances', async () => {
  let mode = 'sse', proxy
  const policy = createSubscriptionConnection({ resolveMode: () => mode, resolveProxy: async () => proxy })
  const input = { apiKey: 'token-one', sessionId: 'conversation', transport: 'auto' }
  try {
    assert.equal((await policy.prepare(input)).options.transport, 'sse')
    mode = 'websocket'
    const first = await policy.prepare(input)
    assert.equal(first.options.transport, 'websocket-cached')
    assert.equal(first.options.sessionId, (await policy.prepare(input)).options.sessionId)
    assert.ok(!first.options.sessionId.includes(input.apiKey))
    assert.notEqual(first.options.sessionId, (await policy.prepare({ ...input, apiKey: 'token-two' })).options.sessionId)
    assert.notEqual(first.options.sessionId, (await policy.prepare({ ...input, requestedModel: 'gpt-6-astra' })).options.sessionId)
    proxy = 'http://localhost:1001'
    assert.notEqual(first.options.sessionId, (await policy.prepare(input)).options.sessionId)
    const second = createSubscriptionConnection({ resolveMode: () => mode, resolveProxy: async () => undefined })
    assert.notEqual(first.options.sessionId, (await second.prepare(input)).options.sessionId)
    second.dispose()
    mode = 'sse'
    assert.equal((await policy.prepare(input)).options.sessionId, 'conversation')
  } finally { policy.dispose() }
})

test('a rejected WebSocket proxy CONNECT falls back through the existing SSE route, without changing global proxy settings', async () => {
  let connects = 0, fetches = 0
  const server = http.createServer()
  server.on('connect', (_request, socket) => { connects++; socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const proxy = `http://127.0.0.1:${server.address().port}`
  const originalWebSocket = globalThis.WebSocket, originalEnv = process.env.HTTPS_PROXY
  const connection = createSubscriptionConnection({ resolveMode: () => 'websocket', resolveProxy: async () => proxy })
  const network = createCodexNetworkTransport({ env: { HTTPS_PROXY: proxy }, fetchThroughProxy: async (_input, _init, route) => {
    assert.equal(route, `${proxy}/`)
    fetches++
    return new Response('data: {"type":"response.created","response":{"id":"fallback"}}\n\ndata: {"type":"response.done","response":{"id":"fallback","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const provider = openaiCodexSubscriptionProvider({ connection, runNetwork: network.run })
  const apiKey = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.fake`
  try {
    const model = provider.getModels().find(model => model.id === 'gpt-5.6-luna')
    const stream = provider.streamSimple(model, { messages: [{ role: 'user', content: 'test', timestamp: Date.now() }] }, { apiKey, sessionId: 'proxy-failure', signal: AbortSignal.timeout(5000) })
    const events = []
    for await (const event of stream) events.push(event.type)
    assert.ok(events.includes('done'), events.join(','))
    assert.equal(connects, 1)
    assert.equal(fetches, 1)
    assert.equal(globalThis.WebSocket, originalWebSocket)
    assert.equal(process.env.HTTPS_PROXY, originalEnv)
  } finally { connection.dispose(); await new Promise(resolve => server.close(resolve)) }
})

test('a disconnect after response acceptance is surfaced without replaying the request over SSE', async () => {
  const originalSocket = globalThis.WebSocket, originalFetch = globalThis.fetch
  let fetches = 0, sends = 0
  class InterruptedSocket extends EventTarget {
    readyState = 1
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    send() {
      sends++
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'accepted' } }) }))
        setImmediate(() => this.close())
      })
    }
    close() { if(this.readyState===3)return; this.readyState=3; const event=new Event('close'); Object.assign(event,{code:1006,reason:'fixture disconnect',wasClean:false}); this.dispatchEvent(event) }
  }
  globalThis.WebSocket = InterruptedSocket
  globalThis.fetch = async () => { fetches++; throw Error('must not replay') }
  const connection = createSubscriptionConnection({ resolveMode: () => 'websocket', resolveProxy: async () => undefined })
  const provider = openaiCodexSubscriptionProvider({ connection })
  const apiKey = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.fake`
  try {
    const model = provider.getModels().find(model => model.id === 'gpt-5.6-luna')
    const events=[]
    for await(const event of provider.streamSimple(model,{messages:[{role:'user',content:'fixture',timestamp:Date.now()}]},{apiKey,sessionId:'interrupted',signal:AbortSignal.timeout(3000)})) events.push(event)
    assert.ok(events.some(event => event.type === 'start'))
    const failure = events.find(event => event.type === 'error')
    assert.match(failure?.error.errorMessage, /^Network transport failure: WebSocket closed 1006/)
    assert.equal(sends,1)
    assert.equal(fetches,0)
  } finally { connection.dispose();globalThis.WebSocket=originalSocket;globalThis.fetch=originalFetch }
})
