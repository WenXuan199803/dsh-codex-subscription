import assert from 'node:assert/strict'
import test from 'node:test'

import { createAccountUsageService } from '../src/account-usage.js'

test('per-account usage reads every account without changing active selection', async () => {
  const accounts = [
    { id: 'a', label: 'A', active: true },
    { id: 'b', label: 'B', active: false },
  ]
  const calls = []
  const store = {
    withAccount(id, operation) {
      calls.push(id)
      return operation()
    },
  }
  const service = createAccountUsageService({
    accountVault: { async list() { return accounts } },
    store,
    createReader: id => ({
      async read() {
        if (id === 'b') throw new Error('private upstream detail')
        return {
          rateLimits: [{
            id: 'codex',
            windows: [{ remainingPercent: 75, windowSeconds: 18_000 }],
          }],
        }
      },
      clear() {},
    }),
  })
  const result = await service.readAll()
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(result.accounts[0].id, 'a')
  assert.equal(result.accounts[0].usage.rateLimits[0].windows[0].remainingPercent, 75)
  assert.deepEqual(result.accounts[1], { id: 'b', error: 'Could not read ChatGPT usage' })
  assert.equal(accounts.find(account => account.active).id, 'a')
})
