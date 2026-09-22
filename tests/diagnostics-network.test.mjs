import assert from 'node:assert/strict'
import test from 'node:test'

import { createSubscriptionDiagnostics } from '../src/diagnostics.js'

const preferences = {
  status: () => ({
    contextMode: 'standard',
    quickQuotaMode: 'percent',
    outputVerbosity: 'default',
    searchProvider: 'auto',
    speedMode: 'standard',
    writable: true,
  }),
}

test('support diagnostics expose only safe actual transport and fallback fields', async () => {
  const report = await createSubscriptionDiagnostics({
    auth: { status: async () => ({ authenticated: true }) },
    preferences,
    network: {
      snapshot: () => ({
        model: {
          status: 'ok',
          route: 'system',
          elapsed: '1-5s',
          transport: 'sse',
          fallback: 'websocket-to-sse',
          proxy: 'http://user:secret@127.0.0.1:7890',
          accountId: 'private-account',
        },
      }),
    },
  })

  assert.deepEqual(report.requests.model, {
    status: 'ok',
    route: 'system',
    transport: 'sse',
    fallback: 'websocket-to-sse',
    elapsed: '1-5s',
  })
  assert.doesNotMatch(JSON.stringify(report), /secret|127\.0\.0\.1|private-account/u)
})

test('support diagnostics drop unknown transport labels instead of echoing arbitrary data', async () => {
  const report = await createSubscriptionDiagnostics({
    auth: { status: async () => ({ authenticated: true }) },
    preferences,
    network: {
      snapshot: () => ({
        model: {
          status: 'ok',
          route: 'direct',
          elapsed: 'under-1s',
          transport: 'custom-secret-route',
          fallback: 'unexpected',
        },
      }),
    },
  })

  assert.deepEqual(report.requests.model, {
    status: 'ok',
    route: 'direct',
    elapsed: 'under-1s',
  })
})
