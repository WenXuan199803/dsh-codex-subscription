import assert from 'node:assert/strict'
import test from 'node:test'

import { completeMinimalQuotaActivation, createQuotaActivationService, credentialPlanType } from '../src/quota-activation.js'

const access = plan => `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_plan_type: plan },
})).toString('base64url')}.signature`

test('minimal 5h activation is an isolated single-message request contract', async () => {
  const calls = []
  const models = { async completeSimple(model, context, options) {
    calls.push({ model, context, options })
    return { stopReason: 'stop', content: [{ type: 'text', text: 'HI' }] }
  } }
  const model = { id: 'gpt-6-luna' }
  await completeMinimalQuotaActivation(models, model, () => 1234)
  assert.deepEqual(calls, [{
    model,
    context: { messages: [{ role: 'user', content: 'Reply HI', timestamp: 1234 }] },
    options: { reasoning: 'low', cacheRetention: 'none' },
  }])
  assert.equal(Object.hasOwn(calls[0].context, 'systemPrompt'), false)
  assert.equal(Object.hasOwn(calls[0].context, 'tools'), false)
})

test('rolling activation primes only enabled Plus accounts and follows the returned 5h reset', async () => {
  const now = 1_000_000
  const activations = []
  const timers = []
  const accounts = [
    { id: 'plus', enabled: true },
    { id: 'pro', enabled: true },
    { id: 'disabled', enabled: false },
  ]
  const credentials = {
    plus: { access: access('plus') },
    pro: { access: access('pro') },
    disabled: { access: access('plus') },
  }
  const service = createQuotaActivationService({
    listAccounts: async () => accounts,
    readCredential: async id => credentials[id],
    activate: async id => { activations.push(id) },
    readUsage: async () => ({ usage: { rateLimits: [{ id: 'codex', windows: [
      { windowSeconds: 18_000, remainingPercent: 100, resetsAt: 20_000 },
    ] }] } }),
    enabled: () => true,
    now: () => now,
    setTimer: (callback, delay) => { const handle = { callback, delay }; timers.push(handle); return handle },
    clearTimer: () => {},
  })
  await service.sync()
  assert.deepEqual(activations, ['plus'])
  assert.equal(timers.length, 1)
  assert.equal(timers[0].delay, 20_000 * 1000 + 2_000 - now)
  assert.equal(credentialPlanType(credentials.plus), 'plus')
  assert.equal(credentialPlanType(credentials.pro), 'pro')
  service.dispose()
})

test('rolling activation is fully dormant when the global switch is off', async () => {
  let activated = false
  const service = createQuotaActivationService({
    listAccounts: async () => [{ id: 'plus', enabled: true }],
    readCredential: async () => ({ access: access('plus') }),
    activate: async () => { activated = true },
    readUsage: async () => undefined,
    enabled: () => false,
  })
  await service.sync()
  assert.equal(activated, false)
  assert.deepEqual(service.snapshot(), { accounts: 0, timers: 0 })
  service.dispose()
})
