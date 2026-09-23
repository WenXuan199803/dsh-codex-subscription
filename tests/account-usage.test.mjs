import assert from 'node:assert/strict'
import test from 'node:test'
import { createAccountUsageService } from '../src/account-usage.js'
import { RPC_ENDPOINTS } from '../src/rpc-contract.js'

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

test('disabled accounts are not queried for usage', async () => {
  const service = createAccountUsageService({
    accountVault: { async list() { return [{ id: 'disabled', enabled: false }] } },
    store: { withAccount() { assert.fail('disabled account must not be read') } },
    createReader() { assert.fail('disabled account must not create a reader') },
  })
  assert.deepEqual((await service.readAll()).accounts, [{ id: 'disabled', disabled: true }])
})

const access = plan => `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_plan_type: plan },
})).toString('base64url')}.signature`

test('account pool excludes disabled accounts and weights independent windows by plan capacity', async () => {
  assert.ok(RPC_ENDPOINTS.includes('usage/pool'))
  let current
  const accountVault = { async list() { return [
    { id: 'plus', enabled: true },
    { id: 'prolite', enabled: true },
    { id: 'disabled', enabled: false },
  ] } }
  const store = {
    async withAccount(id, operation) { current = id; return operation() },
    async read() { return { access: access(current === 'plus' ? 'plus' : 'prolite') } },
  }
  const service = createAccountUsageService({
    accountVault, store,
    createReader: id => ({ async read() { return { rateLimits: [{ id: 'codex', windows: [
      { windowSeconds: 18_000, remainingPercent: id === 'plus' ? 80 : 20, resetsAt: 1_900_000_000 },
      { windowSeconds: 604_800, remainingPercent: id === 'plus' ? 40 : 70, resetsAt: 1_900_500_000 },
    ] }] } } }),
  })
  const pool = await service.readPool()
  assert.equal(pool.total, 2)
  assert.equal(pool.failed, 0)
  assert.equal(pool.windows['5h'].remaining, 30)
  assert.equal(pool.windows.week.remaining, 65)
  assert.equal(pool.windows['5h'].capacity, 6)
  assert.equal(pool.accounts.length, 2)
  assert.doesNotMatch(JSON.stringify(pool), /access|refresh|chatgpt_account_id/u)
})
