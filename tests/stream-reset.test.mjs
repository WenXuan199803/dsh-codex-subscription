import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import vm from 'node:vm'

// Exercise the shipped entry as well as source; no credentials or external traffic.
const source = readFileSync(new URL('../src/oauth-network.js', import.meta.url), 'utf8')
const bundle = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
function load(text) {
  const start = text.indexOf('function proxyResponseBody(')
  const end = text.indexOf('function fetchThroughProxy(', start)
  const declaration = text.slice(start, end).replace(/export\s*$/, '')
  return vm.runInNewContext(declaration + '\nproxyResponseBody', { Readable, ReadableStream, Error })
}
for (const [label, text] of [['source', source], ['release', bundle]]) {
  const bodyOf = load(text)
  test(`${label}: real TCP reset after SSE data stays a retryable connection failure`, async () => {
    const server = createServer((req,res) => {
      res.writeHead(200, {'Content-Type':'text/event-stream'})
      res.write('data: partial\n\n')
      setTimeout(() => res.destroy(), 15)
    })
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
    const abort = new AbortController()
    try {
      const incoming = await new Promise((resolve,reject) => get(`http://127.0.0.1:${server.address().port}`,resolve).on('error',reject))
      const reader = bodyOf(incoming, abort.signal).getReader()
      const first = await reader.read()
      assert.equal(new TextDecoder().decode(first.value),'data: partial\n\n')
      await assert.rejects(reader.read(), error => {
        assert.match(error.message, /connection closed \(ECONNRESET\)/)
        assert.equal(error.cause.code,'ECONNRESET')
        assert.equal(abort.signal.aborted,false)
        return true
      })
    } finally { await new Promise(resolve => server.close(resolve)) }
  })
  test(`${label}: caller cancellation preserves its original error`, async () => {
    const abort = new AbortController()
    const incoming = new Readable({read(){}})
    const reader = bodyOf(incoming,abort.signal).getReader()
    const pending = reader.read()
    abort.abort()
    const reason = Object.assign(new Error('aborted'),{code:'ECONNRESET'})
    incoming.destroy(reason)
    await assert.rejects(pending, error => error === reason)
  })
  test(`${label}: complete body and downstream cancel keep stream semantics`, async () => {
    const body = bodyOf(Readable.from([Buffer.from('data: OK\n\n'),Buffer.from('data: [DONE]\n\n')]))
    assert.equal(await new Response(body).text(),'data: OK\n\ndata: [DONE]\n\n')
    const incoming = new Readable({read(){}})
    await bodyOf(incoming).cancel('user stopped reading')
    assert.equal(incoming.destroyed,true)
  })
  test(`${label}: unrelated errors remain unchanged`, async () => {
    const incoming = new Readable({read(){}})
    const reader=bodyOf(incoming).getReader()
    const pending=reader.read()
    const reason=Object.assign(new Error('invalid data'),{code:'BAD_DATA'})
    incoming.destroy(reason)
    await assert.rejects(pending,error=>error===reason)
  })
}
