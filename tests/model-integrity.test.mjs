import assert from 'node:assert/strict'
import test from 'node:test'
import { guardSseModel } from '../src/model-integrity.js'

test('split CRLF SSE frames cannot hide an upstream model substitution', async () => {
  const bytes = new TextEncoder().encode('data: {"type":"response.created","response":{"model":"gpt-5.6-sol"}}\r\n\r\n')
  const response = new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3))
    controller.close()
  } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const guarded = guardSseModel(response, new URL('https://chatgpt.com/backend-api/codex/responses'), 'gpt-6-astra')
  await assert.rejects(guarded.text(), /Upstream model mismatch/u)
})
