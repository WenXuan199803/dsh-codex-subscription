import assert from 'node:assert/strict'
import test from 'node:test'
import { createUsageCache } from '../src/client-usage-cache.js'

function memoryStorage() {
  const values = new Map()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
    removeItem(key) { values.delete(key) },
  }
}

test('quota cache survives page remount while isolating accounts and omitting credentials', () => {
  let now = 1_800_000_000_000
  const backing = memoryStorage()
  const usage = {
    fetchedAt: now,
    rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 76, usedPercent: 24,
      windowSeconds: 18_000, resetsAt: 1_800_010_000 }] }],
    access: 'must-not-cache',
    resetCredits: { availableCount: 1 },
  }
  const first = createUsageCache({ storage: () => backing, now: () => now })
  first.write('account-a', usage)
  assert.equal(first.read('account-b'), undefined)
  const mountedAgain = createUsageCache({ storage: () => backing, now: () => now })
  assert.equal(mountedAgain.read('account-a').rateLimits[0].windows[0].remainingPercent, 76)
  assert.doesNotMatch(JSON.stringify(mountedAgain.read('account-a')), /must-not-cache|resetCredits/u)
  mountedAgain.prune(['account-b'])
  assert.equal(mountedAgain.read('account-a'), undefined)
  first.write('account-a', usage)
  now += 8 * 24 * 60 * 60 * 1000
  assert.equal(createUsageCache({ storage: () => backing, now: () => now }).read('account-a'), undefined)
})

test('clearing cached quota removes every account after sign out', () => {
  const backing = memoryStorage()
  const now = 1_800_000_000_000
  const cache = createUsageCache({ storage: () => backing, now: () => now })
  for (const id of ['a', 'b']) cache.write(id, { fetchedAt: now,
    rateLimits: [{ id: 'codex', windows: [{ remainingPercent: 50, windowSeconds: 604_800 }] }] })
  cache.clear()
  assert.equal(backing.length, 0)
  assert.equal(cache.read('a'), undefined)
  assert.equal(cache.read('b'), undefined)
})
