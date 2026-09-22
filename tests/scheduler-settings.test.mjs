import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexLoginCoordinator } from '../src/login-coordinator.js'

test('scheduler RPC policy updates normal settings and never writes the credential vault', async () => {
  let config = { strategy: 'fill-first', sessionAffinity: true }
  let settingsWrites = 0
  const accountVault = {
    async list() { return [{ id: 'a', label: 'A', active: true }] },
    async activeId() { return 'a' },
    async scheduler() { assert.fail('scheduler status must not read policy from credential vault') },
    async updateScheduler() { assert.fail('scheduler update must not write credential vault') },
  }
  const coordinator = new CodexLoginCoordinator({
    async status() { return { authenticated: true, provider: 'openai-codex', accounts: await accountVault.list() } },
  }, {
    accountVault,
    scheduler: { snapshot() { return { bindings: 0, cooldowns: [] } } },
    getSchedulerConfig: () => ({ ...config }),
    updateSchedulerConfig: async patch => {
      settingsWrites += 1
      config = { ...config, ...patch }
    },
  })

  assert.deepEqual((await coordinator.schedulerStatus()).config, {
    strategy: 'fill-first',
    sessionAffinity: true,
  })

  const status = await coordinator.updateScheduler({
    strategy: 'round-robin',
    sessionAffinity: false,
  })
  assert.equal(settingsWrites, 1)
  assert.deepEqual(status.config, {
    strategy: 'round-robin',
    sessionAffinity: false,
  })
})
