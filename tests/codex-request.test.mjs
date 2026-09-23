import test from 'node:test'
import assert from 'node:assert/strict'
import { officialCodexRequest } from '../src/codex-request.js'
import { parseOfficialModelCatalog } from '../src/model-catalog.js'
const metadata = { useResponsesLite: true, defaultReasoningSummary: 'none', defaultReasoningEffort: 'medium' }
const payload = () => ({
  model: 'gpt-5.6-sol', instructions: 'Keep all instructions',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Keep all context' }] }],
  tools: [{ type: 'function', name: 'bash', parameters: { type: 'object' } }, { type: 'custom', name: 'patch', format: { type: 'text' } }],
  reasoning: { effort: 'high', summary: 'auto' }, prompt_cache_key: 'session:account:a',
  include: ['reasoning.encrypted_content'], parallel_tool_calls: true, store: false, service_tier: 'priority',
})
test('catalog-selected official envelope preserves effort, model, tools and full context', () => {
  const original = payload(), before = structuredClone(original)
  const result = officialCodexRequest(original, metadata)
  assert.deepEqual(original, before)
  assert.equal(result.model, original.model)
  assert.equal(result.service_tier, 'priority')
  assert.deepEqual(result.reasoning, { effort: 'high', context: 'all_turns' })
  assert.deepEqual(result.input.slice(2), original.input)
  assert.equal(result.input[1].role, 'developer')
  assert.equal(result.input[1].content[0].text, original.instructions)
  assert.deepEqual(result.input[0].tools[0].tools, original.tools)
  assert.equal(result.tools, undefined)
  assert.equal(result.instructions, undefined)
  assert.equal(result.parallel_tool_calls, false)
  assert.equal(result.store, false)
  assert.deepEqual(result.include, original.include)
})
test('stable prefix IDs allow delta continuation and invalidate on account or tool changes', () => {
  const first = officialCodexRequest(payload(), metadata)
  const second = officialCodexRequest({ ...payload(), input: [...payload().input, { role: 'user', content: 'next' }] }, metadata)
  assert.deepEqual(first.input, second.input.slice(0, first.input.length))
  const switched = officialCodexRequest({ ...payload(), prompt_cache_key: 'session:account:b' }, metadata)
  assert.notEqual(first.input[0].id, switched.input[0].id)
  const toolChanged = officialCodexRequest({ ...payload(), tools: [] }, metadata)
  assert.notEqual(first.input[0].id, toolChanged.input[0].id)
})
test('legacy models and missing catalogs never acquire Lite formatting', () => {
  const p = payload()
  assert.equal(officialCodexRequest(p), p)
  const legacy = officialCodexRequest(p, { useResponsesLite: false, defaultReasoningSummary: 'auto' })
  assert.deepEqual(legacy, p)
  const noSummary = officialCodexRequest(p, { supportsReasoningSummary: false })
  assert.deepEqual(noSummary.reasoning, { effort: 'high' })
  assert.deepEqual(noSummary.tools, p.tools)
})
test('catalog retains the actual protocol and reasoning defaults', () => {
  const [m] = parseOfficialModelCatalog({ models: [{ slug: 'model', visibility: 'list', use_responses_lite: true,
    default_reasoning_summary: 'none', supports_reasoning_summary_parameter: true, default_reasoning_level: 'high' }] })
  assert.equal(m.useResponsesLite, true)
  assert.equal(m.defaultReasoningSummary, 'none')
  assert.equal(m.supportsReasoningSummary, true)
  const p = payload(); delete p.reasoning
  assert.equal(officialCodexRequest(p, m).reasoning.effort, 'high')
})
