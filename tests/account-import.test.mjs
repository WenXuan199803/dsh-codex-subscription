import assert from 'node:assert/strict'
import test from 'node:test'

import { parseAccountImport } from '../src/account-import.js'

const cpa = (suffix, extra = {}) => ({
  type: 'codex',
  access_token: `access-${suffix}`,
  refresh_token: `refresh-${suffix}`,
  expired: '2030-01-01T00:00:00.000Z',
  email: `${suffix}@example.com`,
  ...extra,
})

function storedZip(entries) {
  const locals = []
  const central = []
  let localOffset = 0
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name)
    const body = Buffer.from(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBytes, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(body.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(localOffset, 42)
    central.push(entry, nameBytes)
    localOffset += local.length + nameBytes.length + body.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}

test('imports a CPA Codex JSON credential', () => {
  const encoded = Buffer.from(JSON.stringify(cpa('one'))).toString('base64')
  const accounts = parseAccountImport({ name: 'codex-one.json', encoded })
  assert.equal(accounts.length, 1)
  assert.equal(accounts[0].label, 'one@example.com')
  assert.deepEqual(accounts[0].credential, {
    type: 'oauth',
    access: 'access-one',
    refresh: 'refresh-one',
    expires: Date.parse('2030-01-01T00:00:00.000Z'),
    email: 'one@example.com',
  })
})

test('imports nested SUB2API-style account collections and deduplicates refresh tokens', () => {
  const payload = {
    accounts: [
      { credentials: cpa('one') },
      { auth: { ...cpa('two'), name: 'Second' } },
      { duplicate: cpa('one') },
    ],
  }
  const accounts = parseAccountImport({
    name: 'sub2api.json',
    encoded: Buffer.from(JSON.stringify(payload)).toString('base64'),
  })
  assert.equal(accounts.length, 2)
  assert.deepEqual(accounts.map(account => account.credential.refresh).sort(), ['refresh-one', 'refresh-two'])
})

test('imports many CPA JSON files from one ZIP', () => {
  const zip = storedZip([
    ['a.json', JSON.stringify(cpa('a'))],
    ['nested/b.json', JSON.stringify(cpa('b'))],
    ['ignore.txt', 'not json'],
  ])
  const accounts = parseAccountImport({ name: 'accounts.zip', encoded: zip.toString('base64') })
  assert.deepEqual(accounts.map(account => account.credential.refresh).sort(), ['refresh-a', 'refresh-b'])
})


test('imports account id from CPA metadata and from the official access-token claim', () => {
  const direct = parseAccountImport({
    name: 'direct.json',
    encoded: Buffer.from(JSON.stringify(cpa('direct', { account_id: 'acc-direct' }))).toString('base64'),
  })
  assert.equal(direct[0].credential.accountId, 'acc-direct')

  const jwtPayload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-jwt' },
  })).toString('base64url')
  const jwt = cpa('jwt', { access_token: `header.${jwtPayload}.signature` })
  const fromJwt = parseAccountImport({
    name: 'jwt.json',
    encoded: Buffer.from(JSON.stringify(jwt)).toString('base64'),
  })
  assert.equal(fromJwt[0].credential.accountId, 'acc-jwt')
})
