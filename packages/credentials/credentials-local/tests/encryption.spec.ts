import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '../src/index.ts'
import {
  decryptCredentialDocument,
  encryptCredentialDocument,
  readDocumentEncryptionKey,
} from '../src/encryption.ts'

const REF = credentialRef('DEEPSEEK_API_KEY')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-encryption-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function keyFile(dir: string, key = randomBytes(32)): Promise<{ path: string; key: Buffer }> {
  const path = join(dir, 'provider.key')
  await writeFile(path, `${key.toString('base64url')}\n`, { mode: 0o600 })
  return { path, key }
}

async function boot(path: string, encryptionKeyFile: string): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { path, encryptionKeyFile, watch: false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

describe('encrypted credential documents', () => {
  it('round-trips with a fresh nonce and rejects tampering without quoting plaintext', () => {
    const key = randomBytes(32)
    const plaintext = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-never-log\n'
    const first = encryptCredentialDocument(plaintext, key)
    const second = encryptCredentialDocument(plaintext, key)
    expect(first).not.toBe(second)
    expect(first).not.toContain('sk-never-log')
    expect(decryptCredentialDocument(first, key, '/credentials.enc')).toBe(plaintext)
    const tampered = `${first.slice(0, -3)}AA\n`
    expect(() => decryptCredentialDocument(tampered, key, '/credentials.enc'))
      .toThrow('encrypted document authentication failed at /credentials.enc')
  })

  it('rejects noncanonical envelopes', () => {
    const key = randomBytes(32)
    expect(() => decryptCredentialDocument('version: 1\n', key, '/credentials.enc'))
      .toThrow('not a canonical encrypted credential document')
    expect(() => decryptCredentialDocument('dsh-credentials-encrypted-v1:A\n', key, '/credentials.enc'))
      .toThrow('not a canonical encrypted credential document')
  })

  it('loads only a private canonical key file', async () => {
    const dir = await tempDir()
    const valid = await keyFile(dir)
    await expect(readDocumentEncryptionKey(valid.path)).resolves.toEqual(valid.key)
    await writeFile(valid.path, valid.key.toString('base64url'), { mode: 0o600 })
    await expect(readDocumentEncryptionKey(valid.path)).resolves.toEqual(valid.key)
    await writeFile(valid.path, '', { mode: 0o600 })
    await expect(readDocumentEncryptionKey(valid.path)).rejects.toThrow(/canonical 32-byte base64url key/)
    await writeFile(valid.path, 'x'.repeat(129), { mode: 0o600 })
    await expect(readDocumentEncryptionKey(valid.path)).rejects.toThrow(/canonical 32-byte base64url key/)
    await writeFile(valid.path, 'not-a-key\n', { mode: 0o600 })
    await expect(readDocumentEncryptionKey(valid.path)).rejects.toThrow(/canonical 32-byte base64url key/)
    await writeFile(valid.path, `${randomBytes(32).toString('base64url')}\n\n`, { mode: 0o600 })
    await expect(readDocumentEncryptionKey(valid.path)).rejects.toThrow(/canonical 32-byte base64url key/)
  })

  it.skipIf(process.platform === 'win32')('rejects a key file readable by another OS user', async () => {
    const dir = await tempDir()
    const valid = await keyFile(dir)
    await chmod(valid.path, 0o644)
    await expect(readDocumentEncryptionKey(valid.path)).rejects.toThrow(/must be owner-only or a read-only systemd credential/)
  })

  it.skipIf(process.platform === 'win32')('accepts only the exact systemd credential copy mode and directory', async () => {
    const credentialsDirectory = await tempDir()
    const valid = await keyFile(credentialsDirectory)
    await chmod(valid.path, 0o440)
    await expect(readDocumentEncryptionKey(valid.path, credentialsDirectory)).resolves.toEqual(valid.key)

    const adjacentDirectory = await tempDir()
    await expect(readDocumentEncryptionKey(valid.path, adjacentDirectory)).rejects.toThrow(/must be owner-only/)
    await chmod(valid.path, 0o444)
    await expect(readDocumentEncryptionKey(valid.path, credentialsDirectory)).rejects.toThrow(/must be owner-only/)
  })

  it('stores a Models-page write as ciphertext and serves it after restart', async () => {
    const dir = await tempDir()
    const document = join(dir, '.credentials.enc')
    const key = await keyFile(dir)
    const first = await boot(document, key.path)
    await first.credentials.set(REF, 'sk-user-owned-secret')
    const stored = await readFile(document, 'utf8')
    expect(stored).toMatch(/^dsh-credentials-encrypted-v1:/)
    expect(stored).not.toContain('sk-user-owned-secret')

    const second = await boot(document, key.path)
    await expect(second.credentials.resolve(REF)).resolves.toEqual({ value: 'sk-user-owned-secret', source: 'file' })
  })

  it('migrates a recognized encrypted flat document without writing plaintext', async () => {
    const dir = await tempDir()
    const document = join(dir, '.credentials.enc')
    const key = await keyFile(dir)
    await writeFile(document, encryptCredentialDocument('DEEPSEEK_API_KEY: sk-pre-release\n', key.key), { mode: 0o600 })

    const ctx = await boot(document, key.path)
    await expect(ctx.credentials.resolve(REF)).resolves.toEqual({ value: 'sk-pre-release', source: 'file' })
    const stored = await readFile(document, 'utf8')
    expect(stored).not.toContain('sk-pre-release')
    expect(decryptCredentialDocument(stored, key.key, document))
      .toBe('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-pre-release\n')
  })

  it('fails closed when the configured key cannot authenticate the document', async () => {
    const dir = await tempDir()
    const document = join(dir, '.credentials.enc')
    const firstKey = await keyFile(dir)
    const first = await boot(document, firstKey.path)
    await first.credentials.set(REF, 'sk-sensitive-value')
    const replacement = randomBytes(32)
    await writeFile(firstKey.path, `${replacement.toString('base64url')}\n`, { mode: 0o600 })
    await expect(new Context().plugin(LocalCredentialProvider, {
      path: document,
      encryptionKeyFile: firstKey.path,
      watch: false,
    })).rejects.toThrow(/encrypted document authentication failed/)
  })
})
