import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
const MAX_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
const MAX_ENTRIES = 1000

const asObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const text = value => typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined
  const encoded = token.split('.')[1]
  if (!encoded) return undefined
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { return undefined }
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function credentialFromObject(raw) {
  const value = asObject(raw)
  if (!value) return undefined
  const nested = [value, asObject(value.metadata), asObject(value.credential), asObject(value.tokens)].filter(Boolean)
  const pick = (...keys) => {
    for (const source of nested) for (const key of keys) {
      const hit = source[key]
      if (hit !== undefined && hit !== null && hit !== '') return hit
    }
  }
  const access = text(pick('access_token', 'accessToken', 'access'))
  const refresh = text(pick('refresh_token', 'refreshToken', 'refresh'))
  if (!access || !refresh) return undefined

  let expires = timestamp(pick('expired', 'expires_at', 'expiresAt', 'expires'))
  if (expires === undefined) {
    const issued = timestamp(pick('timestamp', 'issued_at', 'issuedAt'))
    const expiresIn = Number(pick('expires_in', 'expiresIn'))
    if (issued !== undefined && Number.isFinite(expiresIn) && expiresIn > 0) expires = issued + expiresIn * 1000
  }
  if (expires === undefined) {
    const exp = decodeJwtPayload(access)?.exp
    if (Number.isFinite(exp)) expires = Number(exp) * 1000
  }
  if (expires === undefined) expires = Date.now() + 5 * 60 * 1000

  const email = text(pick('email')) ?? text(decodeJwtPayload(access)?.['https://api.openai.com/profile']?.email)
  const label = text(pick('label', 'name', 'account_name', 'accountName')) ?? email
  return {
    label,
    credential: {
      type: 'oauth',
      access,
      refresh,
      expires,
      ...(email ? { email } : {}),
    },
  }
}

function collectCandidates(value, out, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  const candidate = credentialFromObject(value)
  if (candidate) out.push(candidate)
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, out, seen)
    return
  }
  for (const child of Object.values(value)) collectCandidates(child, out, seen)
}

function parseJsonBytes(bytes, fallbackLabel) {
  let parsed
  try { parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) } catch { return [] }
  const out = []
  collectCandidates(parsed, out)
  return out.map((entry, index) => ({
    ...entry,
    label: entry.label ?? (out.length === 1 ? fallbackLabel : `${fallbackLabel} ${index + 1}`),
  }))
}

function zipEntries(buffer) {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Import archive exceeds 10 MiB')
  const endSig = 0x06054b50
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === endSig) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Invalid ZIP archive')
  const count = buffer.readUInt16LE(eocd + 10)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (count > MAX_ENTRIES) throw new Error('Import archive contains too many files')
  let offset = centralOffset
  let total = 0
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP directory')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    offset += 46 + nameLength + extraLength + commentLength
    if (!/\.json$/iu.test(name) || name.endsWith('/')) continue
    if ((flags & 1) !== 0) throw new Error('Encrypted ZIP entries are not supported')
    if (![0, 8].includes(method)) throw new Error('Unsupported ZIP compression method')
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP local header')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > buffer.length) throw new Error('Truncated ZIP entry')
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
    const bytes = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    if (uncompressedSize !== 0 && bytes.byteLength !== uncompressedSize) throw new Error('ZIP entry size mismatch')
    total += bytes.byteLength
    if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('Import archive expands beyond 32 MiB')
    entries.push({ name, bytes })
  }
  return entries
}

export function parseAccountImport({ name = 'accounts.json', encoded }) {
  if (typeof encoded !== 'string' || encoded.length === 0) throw new Error('Import file is empty')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Import file has an invalid size')
  const imported = []
  if (/\.zip$/iu.test(name) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    for (const entry of zipEntries(bytes)) imported.push(...parseJsonBytes(entry.bytes, entry.name.replace(/\.json$/iu, '')))
  } else {
    imported.push(...parseJsonBytes(bytes, name.replace(/\.json$/iu, '')))
  }
  if (imported.length === 0) throw new Error('No Codex OAuth accounts were found')
  const unique = new Map()
  for (const entry of imported) {
    const key = createHash('sha256').update(entry.credential.refresh).digest('hex')
    if (!unique.has(key)) unique.set(key, entry)
  }
  return [...unique.values()]
}
