import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  type KeyObject,
} from 'node:crypto'
import { win32 } from 'node:path'
import { loadWindowsCurrentUserSid } from './windows-current-user-native.ts'
import { loadWindowsHostRegistrationFileBindings } from './windows-host-registration-native.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const MAX_IDENTITY_BYTES = 16 * 1024

interface WindowsEmbeddingIdentityRecord {
  readonly schema_version: 1
  readonly installation_id: string
  readonly endpoint_registration_id: string
  readonly installation_public_key: string
  readonly runtime_generation: number
  readonly schema_generation: number
}

/** Public installation identity and private-file locations; contains no private key bytes. */
export interface WindowsDesktopHostEmbeddingIdentity {
  readonly root: string
  readonly deviceIndexKeyPath: string
  readonly accountKeyringPath: string
  readonly accountKeyringSha256: string
  readonly installationPrivateKeyPath: string
  readonly installationPublicKey: string
  readonly installationId: string
  readonly endpointRegistrationId: string
  readonly runtimeGeneration: number
  readonly schemaGeneration: number
}

/** Native file/SID loaders and entropy providers; omitted providers use production implementations. */
export interface PrepareWindowsDesktopHostEmbeddingIdentityDependencies {
  readonly loadCurrentUserSid?: typeof loadWindowsCurrentUserSid
  readonly loadRegistrationFileBindings?: typeof loadWindowsHostRegistrationFileBindings
  readonly randomBytes?: typeof randomBytes
  readonly randomUUID?: typeof randomUUID
  readonly generateKeyPair?: () => { readonly privateKey: KeyObject; readonly publicKey: KeyObject }
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function windowsRoot(path: string): boolean {
  return DRIVE_ROOTED_PATH.test(path) && !CONTROL_CHARACTER.test(path)
    && !path.slice(2).includes(':') && win32.normalize(path) === path
    && win32.dirname(path) !== path
}

function exactRecord(value: unknown): WindowsEmbeddingIdentityRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostAuthorityError('unavailable')
  }
  const record = value as Record<string, unknown>
  const keys = [
    'endpoint_registration_id',
    'installation_id',
    'installation_public_key',
    'runtime_generation',
    'schema_generation',
    'schema_version',
  ]
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)
    || record.schema_version !== 1
    || typeof record.installation_id !== 'string' || !UUID.test(record.installation_id)
    || typeof record.endpoint_registration_id !== 'string' || !UUID.test(record.endpoint_registration_id)
    || typeof record.installation_public_key !== 'string' || !PUBLIC_KEY.test(record.installation_public_key)
    || typeof record.runtime_generation !== 'number' || !positive(record.runtime_generation)
    || typeof record.schema_generation !== 'number' || !positive(record.schema_generation)) {
    throw new HostAuthorityError('unavailable')
  }
  return record as unknown as WindowsEmbeddingIdentityRecord
}

function readPrivateFile(
  bindings: WindowsHostRegistrationFileBindings,
  path: string,
  maximumBytes: number,
  userSid: string,
): Buffer | undefined {
  const file = bindings.readPrivateFile(path, maximumBytes)
  if (file === undefined) return undefined
  assertWindowsHostPrivatePathEvidence(file.evidence, 'file', userSid)
  if (file.contents.length < 1 || file.contents.length > maximumBytes) {
    throw new HostAuthorityError('unavailable')
  }
  return Buffer.from(file.contents)
}

function createOrReadPrivateFile(
  bindings: WindowsHostRegistrationFileBindings,
  path: string,
  contents: Buffer,
  maximumBytes: number,
  userSid: string,
  securityDescriptor: string,
): Buffer {
  if (bindings.createPrivateFile === undefined) throw new HostAuthorityError('unavailable')
  const result = bindings.createPrivateFile(path, contents, securityDescriptor)
  assertWindowsHostPrivatePathEvidence(result.evidence, 'file', userSid)
  const stable = readPrivateFile(bindings, path, maximumBytes, userSid)
  if (stable === undefined) throw new HostAuthorityError('unavailable')
  return stable
}

function installationPublicKey(privateKey: Buffer): string {
  try {
    const key = createPrivateKey(privateKey)
    const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ed25519' || !Buffer.isBuffer(publicDer) || publicDer.length !== 44) {
      throw new HostAuthorityError('unavailable')
    }
    return publicDer.subarray(-32).toString('base64url')
  } catch (error) {
    if (error instanceof HostAuthorityError) throw error
    throw new HostAuthorityError('unavailable')
  }
}

/**
 * Create or load the durable Windows installation identity with SID/ACL/reparse checks.
 * Existing identity files are retained; successful preparation replaces the pinned account keyring.
 * Failure can leave newly created private files for a later retry and does not authorize their deletion.
 * @param input - Canonical private root, release-pinned keyring, and required identity generations.
 * @param dependencies - Optional native operations and entropy providers.
 * @returns Verified identity and file locations; rejects invalid evidence or conflicting generations.
 */
export async function prepareWindowsDesktopHostEmbeddingIdentity(
  input: {
    readonly platform?: string
    readonly arch?: string
    readonly root: string
    readonly accountAccessKeyring: string
    readonly accountKeyringSha256: string
    readonly runtimeGeneration: number
    readonly schemaGeneration: number
  },
  dependencies: PrepareWindowsDesktopHostEmbeddingIdentityDependencies = {},
): Promise<WindowsDesktopHostEmbeddingIdentity> {
  if ((input.platform ?? process.platform) !== 'win32' || (input.arch ?? process.arch) !== 'x64'
    || !windowsRoot(input.root) || !SHA256.test(input.accountKeyringSha256)
    || createHash('sha256').update(input.accountAccessKeyring).digest('hex') !== input.accountKeyringSha256
    || !positive(input.runtimeGeneration) || !positive(input.schemaGeneration)) {
    throw new HostAuthorityError('invalid_input')
  }
  /* v8 ignore next -- the production SID loader is exercised only by signed Windows lanes. */
  const resolveCurrentUserSid = await (dependencies.loadCurrentUserSid ?? loadWindowsCurrentUserSid)()
  const userSid = resolveCurrentUserSid()
  /* v8 ignore next -- the production filesystem loader is exercised only by signed Windows lanes. */
  const loadBindings = dependencies.loadRegistrationFileBindings ?? loadWindowsHostRegistrationFileBindings
  const bindings = await loadBindings()
  const securityDescriptor = windowsHostPrivateSecurityDescriptor(userSid)
  assertWindowsHostPrivatePathEvidence(
    bindings.ensurePrivateDirectory(input.root, securityDescriptor), 'directory', userSid,
  )
  const identityRoot = win32.join(input.root, 'identity')
  assertWindowsHostPrivatePathEvidence(
    bindings.ensurePrivateDirectory(identityRoot, securityDescriptor), 'directory', userSid,
  )
  const recordPath = win32.join(identityRoot, 'installation.v1.json')
  const deviceIndexKeyPath = win32.join(identityRoot, 'device-index-key.v1')
  const accountKeyringPath = win32.join(identityRoot, 'account-access-keyring.v2.json')
  const installationPrivateKeyPath = win32.join(identityRoot, 'installation-private-key.pem')

  let deviceIndexKey = readPrivateFile(bindings, deviceIndexKeyPath, 32, userSid)
  if (deviceIndexKey === undefined) {
    deviceIndexKey = createOrReadPrivateFile(
      bindings,
      deviceIndexKeyPath,
      /* v8 ignore next -- production entropy is a signed Windows composition dependency. */
      (dependencies.randomBytes ?? randomBytes)(32),
      32,
      userSid,
      securityDescriptor,
    )
  }
  if (deviceIndexKey.length !== 32) throw new HostAuthorityError('unavailable')

  let privateKey = readPrivateFile(bindings, installationPrivateKeyPath, MAX_IDENTITY_BYTES, userSid)
  if (privateKey === undefined) {
    /* v8 ignore next -- production key generation is a signed Windows composition dependency. */
    const keys = (dependencies.generateKeyPair ?? (() => generateKeyPairSync('ed25519')))()
    privateKey = createOrReadPrivateFile(
      bindings,
      installationPrivateKeyPath,
      Buffer.from(keys.privateKey.export({ format: 'pem', type: 'pkcs8' })),
      MAX_IDENTITY_BYTES,
      userSid,
      securityDescriptor,
    )
  }
  const publicKey = installationPublicKey(privateKey)

  let recordContents = readPrivateFile(bindings, recordPath, MAX_IDENTITY_BYTES, userSid)
  if (recordContents === undefined) {
    const record: WindowsEmbeddingIdentityRecord = {
      schema_version: 1,
      /* v8 ignore next -- production UUID entropy is a signed Windows composition dependency. */
      installation_id: (dependencies.randomUUID ?? randomUUID)(),
      /* v8 ignore next -- production UUID entropy is a signed Windows composition dependency. */
      endpoint_registration_id: (dependencies.randomUUID ?? randomUUID)(),
      installation_public_key: publicKey,
      runtime_generation: input.runtimeGeneration,
      schema_generation: input.schemaGeneration,
    }
    recordContents = createOrReadPrivateFile(
      bindings,
      recordPath,
      Buffer.from(`${JSON.stringify(record)}\n`),
      MAX_IDENTITY_BYTES,
      userSid,
      securityDescriptor,
    )
  }
  let decodedRecord: unknown
  try {
    decodedRecord = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(recordContents))
  } catch { throw new HostAuthorityError('unavailable') }
  const record = exactRecord(decodedRecord)
  if (record.installation_public_key !== publicKey
    || record.runtime_generation !== input.runtimeGeneration
    || record.schema_generation !== input.schemaGeneration) throw new HostAuthorityError('conflict')

  const keyringEvidence = bindings.replacePrivateFile(
    accountKeyringPath,
    Buffer.from(input.accountAccessKeyring),
    securityDescriptor,
  )
  assertWindowsHostPrivatePathEvidence(keyringEvidence, 'file', userSid)
  const stableKeyring = readPrivateFile(bindings, accountKeyringPath, MAX_IDENTITY_BYTES, userSid)
  if (stableKeyring === undefined
    || createHash('sha256').update(stableKeyring).digest('hex') !== input.accountKeyringSha256) {
    throw new HostAuthorityError('unavailable')
  }
  return {
    root: input.root,
    deviceIndexKeyPath,
    accountKeyringPath,
    accountKeyringSha256: input.accountKeyringSha256,
    installationPrivateKeyPath,
    installationPublicKey: record.installation_public_key,
    installationId: record.installation_id,
    endpointRegistrationId: record.endpoint_registration_id,
    runtimeGeneration: record.runtime_generation,
    schemaGeneration: record.schema_generation,
  }
}
