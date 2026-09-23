import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('ShangShuSheng fork keeps production Codex path free of A/B routing scaffolding', async () => {
  const files = await Promise.all([
    'src/index.js',
    'src/account-scheduler.js',
    'src/login-coordinator.js',
    'src/client-account.jsx',
    'src/client-preferences.jsx',
    'src/settings-contract.js',
  ].map(file => readFile(new URL('../' + file, import.meta.url), 'utf8')))
  const source = files.join('\n')
  for (const forbidden of [
    'ACCOUNT_ROUTING_MODE_NATIVE',
    'account/test-select',
    'nativeTestAccountId',
    'selectTestAccount',
    'Native Direct',
    'scheduler bypass',
  ]) assert.equal(source.includes(forbidden), false, forbidden)
})

test('ShangShuSheng Codex provider keeps verified protocol and full-stream guards', async () => {
  const runtime = await readFile(new URL('../src/pi-ai-runtime.js', import.meta.url), 'utf8')
  const catalog = await readFile(new URL('../src/model-catalog.js', import.meta.url), 'utf8')
  const request = await readFile(new URL('../src/codex-request.js', import.meta.url), 'utf8')
  assert.match(runtime, /AsyncLocalStorage\.snapshot\(\)/u)
  assert.match(runtime, /await catalog\?\.ready\?\.\(\)/u)
  assert.match(runtime, /officialCodexRequest\(requested, metadata\)/u)
  assert.match(runtime, /x-openai-internal-codex-responses-lite/u)
  assert.match(catalog, /use_responses_lite/u)
  assert.match(catalog, /async ready\(\)/u)
  assert.match(request, /ws_request_header_x_openai_internal_codex_responses_lite/u)
  assert.match(request, /reasoning\.context = 'all_turns'/u)
})
