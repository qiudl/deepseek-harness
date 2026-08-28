/**
 * Authenticated at-rest encoding for the managed credential document. The
 * deployment supplies a 32-byte key through a file outside the Harness home;
 * neither configuration nor the encrypted document carries that key.
 * @module @deepseek-ai/dsh-credentials-local/encryption
 */

import { constants, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const PREFIX = 'dsh-credentials-encrypted-v1:'
const AAD = Buffer.from('dsh-credentials-local:v1', 'utf8')
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_KEY_FILE_BYTES = 128
const GROUP_OTHER_BITS = 0o077

/**
 * Read and validate one canonical base64url AES-256 key without logging it.
 * @param filename - absolute deployment-owned key-file path.
 * @returns a newly allocated 32-byte key buffer.
 */
export async function readDocumentEncryptionKey(filename: string): Promise<Buffer> {
  /* v8 ignore next -- Node defines O_NOFOLLOW on supported POSIX targets; the fallback is for platform parity. */
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(filename, constants.O_RDONLY | noFollow)
  try {
    const info = await handle.stat()
    assertPrivateKeyFile(info, filename)
    const raw = await handle.readFile('utf8')
    const encoded = raw.endsWith('\n') ? raw.slice(0, -1) : raw
    const key = Buffer.from(encoded, 'base64url')
    if (raw !== encoded && raw.endsWith('\n\n')) return invalidKey(filename)
    if (key.length !== KEY_BYTES || key.toString('base64url') !== encoded) return invalidKey(filename)
    return key
  } finally {
    await handle.close()
  }
}

function assertPrivateKeyFile(info: Stats, filename: string): void {
  if (!info.isFile() || info.size < 1 || info.size > MAX_KEY_FILE_BYTES) invalidKey(filename)
  /* v8 ignore next -- POSIX coverage cannot take the Windows peer. */
  if (process.platform !== 'win32' && (info.mode & GROUP_OTHER_BITS) !== 0) {
    throw new Error(`credentials-local: encryption key file ${filename} must be owner-only`)
  }
}

function invalidKey(filename: string): never {
  throw new Error(`credentials-local: encryption key file ${filename} must contain one canonical 32-byte base64url key`)
}

/**
 * Encrypt one UTF-8 credential document into the versioned AES-256-GCM envelope.
 * @param plaintext - parsed credential document rendered as YAML.
 * @param key - 32-byte AES key owned by the deployment.
 * @returns canonical authenticated envelope text with a trailing newline.
 */
export function encryptCredentialDocument(plaintext: string, key: Buffer): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const payload = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url')
  return `${PREFIX}${payload}\n`
}

/**
 * Decrypt and authenticate one versioned credential-document envelope.
 * @param stored - canonical encrypted envelope text.
 * @param key - 32-byte AES key owned by the deployment.
 * @param filename - document path used only in value-free diagnostics.
 * @returns authenticated UTF-8 plaintext.
 */
export function decryptCredentialDocument(stored: string, key: Buffer, filename: string): string {
  if (!stored.startsWith(PREFIX) || !stored.endsWith('\n')) return invalidEnvelope(filename)
  const encoded = stored.slice(PREFIX.length, -1)
  const payload = Buffer.from(encoded, 'base64url')
  if (
    payload.length < NONCE_BYTES + TAG_BYTES
    || payload.toString('base64url') !== encoded
  ) return invalidEnvelope(filename)
  const nonce = payload.subarray(0, NONCE_BYTES)
  const tag = payload.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
  const ciphertext = payload.subarray(NONCE_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error(`credentials-local: encrypted document authentication failed at ${filename}`)
  }
}

function invalidEnvelope(filename: string): never {
  throw new Error(`credentials-local: ${filename} is not a canonical encrypted credential document`)
}
