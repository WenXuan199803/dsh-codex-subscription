import test from 'node:test'
import { cleanupSessionResources } from '@earendil-works/pi-ai'
import assert from 'node:assert/strict'
import { openaiCodexSubscriptionProvider } from '../src/pi-ai-runtime.js'
import { createCodexNetworkTransport } from '../src/oauth-network.js'
const jwt = id => `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.signature`

test('delayed streams hold network scope through completion; reused sockets report the current turn and continue', async () => {
  const previous = globalThis.WebSocket
  const sockets = [], requests = []
  let seq = 0, account = 'a', fail = false, catalogReady = false
  class Socket {
    constructor(url, options) {
      this.url = String(url); this.options = options; this.readyState = 1; this.listeners = new Map()
      sockets.push(this); queueMicrotask(() => this.emit('open', {}))
    }
    addEventListener(t, f) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(f) }
    removeEventListener(t, f) { this.listeners.get(t)?.delete(f) }
    emit(t, e) { for (const f of this.listeners.get(t) ?? []) f(e) }
    send(raw) {
      const request = JSON.parse(raw); requests.push(request)
      if (fail) { setTimeout(() => this.emit('message', { data: JSON.stringify({ type: 'error', error: { code: 'server_is_overloaded', message: 'Overloaded' } }) }), 2); return }
      const n = ++seq, id = `msg_${n}`, responseId = `resp_${n}`
      const emit = e => this.emit('message', { data: JSON.stringify(e) })
      setTimeout(() => emit({ type: 'response.created', response: { id: responseId, model: request.model } }), 2)
      setTimeout(() => {
        emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id, role: 'assistant', content: [] } })
        emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: `answer ${n}` })
        emit({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `answer ${n}`, annotations: [] }] } })
        emit({ type: 'response.completed', response: { id: responseId, model: request.model, service_tier: 'default', status: 'completed', usage: { input_tokens: 20, output_tokens: n * 10, output_tokens_details: { reasoning_tokens: n }, total_tokens: 20 + n * 10 } } })
      }, 30)
    }
    close() { this.readyState = 3 }
  }
  const network = createCodexNetworkTransport({ WebSocketImpl: Socket, env: {}, platform: 'linux' })
  const provider = openaiCodexSubscriptionProvider({
    resolveTransport: () => 'auto', resolveSessionId: id => `${id}:account:${account}`, runNetwork: network.run,
    catalog: {
      async ready() { await new Promise(resolve => setTimeout(resolve, 2)); catalogReady = true },
      getModels: x => x, metadata: () => catalogReady ? { useResponsesLite: true, defaultReasoningSummary: 'none' } : undefined,
    },
  })
  const model = provider.getModels().find(m => m.id === 'gpt-5.6-sol')
  const context = { systemPrompt: 'Full system instructions', messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }
  try {
    for (let n = 1; n <= 3; n++) {
      if (n === 3) account = 'b'
      for await (const event of provider.streamSimple(model, context, { apiKey: jwt(account), sessionId: 'scope-lifecycle', reasoning: 'high' })) {
        assert.notEqual(globalThis.WebSocket, previous, 'scope must remain installed even after first event')
        if (event.type === 'done') context.messages.push(event.message)
        assert.notEqual(event.type, 'error', event.error?.errorMessage)
      }
      assert.equal(globalThis.WebSocket, previous)
      const snapshot = network.snapshot().model
      assert.equal(snapshot.outputTokens, n * 10, 'reused connection must not update an earlier request')
      assert.equal(snapshot.reasoningTokens, n)
      assert.equal(snapshot.reasoningEffort, 'high')
      assert.equal(snapshot.responsesLite, true)
      assert.equal(snapshot.continuation, n === 2)
      assert.ok(snapshot.durationMs >= 25)
      context.messages.push({ role: 'user', content: 'next', timestamp: n + 1 })
    }
    assert.equal(sockets.length, 2)
    assert.equal(requests[1].previous_response_id, 'resp_1')
    assert.equal(requests[1].input.length, 1)
    assert.equal(requests[2].previous_response_id, undefined)
    assert.equal(sockets[1].options.headers['chatgpt-account-id'], 'b')
    fail = true
    let sawError = false
    for await (const event of provider.streamSimple(model, context, { apiKey: jwt(account), sessionId: 'scope-lifecycle', reasoning: 'high' })) {
      if (event.type === 'error') sawError = true
    }
    assert.equal(sawError, true)
    assert.equal(network.snapshot().model.status, 'failed')
    assert.equal(network.snapshot().model.stage, 'provider')
  } finally { cleanupSessionResources('scope-lifecycle:account:a'); cleanupSessionResources('scope-lifecycle:account:b'); for (const s of sockets) s.close(); globalThis.WebSocket = previous }
})
