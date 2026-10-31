import { readSync } from 'node:fs'
import { prepareWindowsDesktopHostEmbeddingIdentity } from './windows-embedding-identity.ts'

const MAX_KEYRING_BYTES = 16 * 1024

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length < 1) throw new Error('invalid Windows identity bootstrap input')
  return value
}

function positive(name: string): number {
  const value = Number(required(name))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid Windows identity bootstrap input')
  return value
}

async function main(): Promise<void> {
  const chunks: Buffer[] = []
  let length = 0
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(4096, MAX_KEYRING_BYTES + 1 - length))
    const read = readSync(0, chunk, 0, chunk.length, null)
    if (read === 0) break
    length += read
    if (length > MAX_KEYRING_BYTES) throw new Error('invalid Windows identity bootstrap input')
    chunks.push(chunk.subarray(0, read))
  }
  const source = Buffer.concat(chunks, length)
  if (source.length < 1 || source.length > MAX_KEYRING_BYTES) {
    throw new Error('invalid Windows identity bootstrap input')
  }
  const accountAccessKeyring = new TextDecoder('utf-8', { fatal: true }).decode(source)
  const identity = await prepareWindowsDesktopHostEmbeddingIdentity({
    root: required('DSH_HOST_ROOT'),
    accountAccessKeyring,
    accountKeyringSha256: required('DSH_HOST_ACCOUNT_KEYRING_SHA256'),
    runtimeGeneration: positive('DSH_HOST_RUNTIME_GENERATION'),
    schemaGeneration: positive('DSH_HOST_SCHEMA_GENERATION'),
  })
  process.stdout.write(`${JSON.stringify(identity)}\n`)
}

void main().catch(() => { process.exitCode = 1 })
