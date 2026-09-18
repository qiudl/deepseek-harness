import { createHash } from 'node:crypto'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const CANDIDATE = /^(?:llm-deepseek|llm-pi-ai|web-search-deepseek):[a-z][a-z0-9-]{0,63}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

function document(bytes: Buffer): Buffer {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_DOCUMENT_BYTES) throw new HostAuthorityError('invalid_input')
  return bytes
}

function exact(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join(',') === [...keys].sort().join(',')
}

/** Secret-bearing preimage and expected result for one fenced Profile write. Never send over control IPC. */
export interface LegacyClaimRecovery {
  readonly profileId: string
  readonly candidateId: string
  readonly operationId: string
  readonly targetGeneration: number
  readonly settingsBefore: Buffer
  readonly credentialsBefore: Buffer
  readonly settingsAfterDigest: string
  readonly credentialsAfterDigest: string
}

/** The file authority must publish atomically in the target Profile's owner-private directory. */
export interface LegacyClaimRecoveryFiles {
  read(profileId: string, operationId: string): Buffer | undefined
  replace(profileId: string, operationId: string, bytes: Buffer): void
}

function validate(value: LegacyClaimRecovery): void {
  if (!UUID.test(value.profileId) || !UUID.test(value.operationId) || !CANDIDATE.test(value.candidateId)
    || !Number.isSafeInteger(value.targetGeneration) || value.targetGeneration < 1
    || !DIGEST.test(value.settingsAfterDigest) || !DIGEST.test(value.credentialsAfterDigest)) {
    throw new HostAuthorityError('invalid_input')
  }
  document(value.settingsBefore)
  document(value.credentialsBefore)
}

function decode(bytes: Buffer, profileId: string): LegacyClaimRecovery {
  if (bytes.length < 1 || bytes.length > 2 * MAX_DOCUMENT_BYTES * 4 / 3 + 4096) {
    throw new HostAuthorityError('unavailable')
  }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
  catch { throw new HostAuthorityError('unavailable') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HostAuthorityError('unavailable')
  const record = parsed as Record<string, unknown>
  if (!exact(record, ['version', 'profileId', 'candidateId', 'operationId', 'targetGeneration',
    'settingsBefore', 'credentialsBefore', 'settingsBeforeDigest', 'credentialsBeforeDigest',
    'settingsAfterDigest', 'credentialsAfterDigest']) || record.version !== 1
    || record.profileId !== profileId || typeof record.settingsBefore !== 'string'
    || typeof record.credentialsBefore !== 'string' || typeof record.settingsBeforeDigest !== 'string'
    || typeof record.credentialsBeforeDigest !== 'string') throw new HostAuthorityError('unavailable')
  const base64 = /^[A-Za-z0-9+/]*={0,2}$/u
  if (!base64.test(record.settingsBefore) || !base64.test(record.credentialsBefore)) {
    throw new HostAuthorityError('unavailable')
  }
  const settingsBefore = Buffer.from(record.settingsBefore, 'base64')
  const credentialsBefore = Buffer.from(record.credentialsBefore, 'base64')
  if (settingsBefore.toString('base64') !== record.settingsBefore
    || credentialsBefore.toString('base64') !== record.credentialsBefore
    || digest(settingsBefore) !== record.settingsBeforeDigest
    || digest(credentialsBefore) !== record.credentialsBeforeDigest) throw new HostAuthorityError('unavailable')
  const value = {
    profileId, candidateId: record.candidateId, operationId: record.operationId,
    targetGeneration: record.targetGeneration, settingsBefore, credentialsBefore,
    settingsAfterDigest: record.settingsAfterDigest, credentialsAfterDigest: record.credentialsAfterDigest,
  } as LegacyClaimRecovery
  try { validate(value) } catch { throw new HostAuthorityError('unavailable') }
  return value
}

/** An immutable recovery snapshot. A retry cannot silently replace its original preimage. */
export class LegacyClaimRecoveryStore {
  constructor(private readonly files: LegacyClaimRecoveryFiles) {}

  read(profileId: string, operationId: string): LegacyClaimRecovery | null {
    if (!UUID.test(profileId) || !UUID.test(operationId)) throw new HostAuthorityError('invalid_input')
    const bytes = this.files.read(profileId, operationId)
    if (bytes === undefined) return null
    const value = decode(bytes, profileId)
    if (value.operationId !== operationId) throw new HostAuthorityError('unavailable')
    return value
  }

  prepare(input: Omit<LegacyClaimRecovery, 'settingsAfterDigest' | 'credentialsAfterDigest'> & {
    readonly settingsAfter: Buffer
    readonly credentialsAfter: Buffer
  }): LegacyClaimRecovery {
    const value: LegacyClaimRecovery = {
      profileId: input.profileId, candidateId: input.candidateId, operationId: input.operationId,
      targetGeneration: input.targetGeneration, settingsBefore: document(input.settingsBefore),
      credentialsBefore: document(input.credentialsBefore),
      settingsAfterDigest: digest(document(input.settingsAfter)),
      credentialsAfterDigest: digest(document(input.credentialsAfter)),
    }
    validate(value)
    const existing = this.read(value.profileId, value.operationId)
    if (existing) {
      if (existing.operationId !== value.operationId || existing.candidateId !== value.candidateId
        || existing.targetGeneration !== value.targetGeneration
        || digest(existing.settingsBefore) !== digest(value.settingsBefore)
        || digest(existing.credentialsBefore) !== digest(value.credentialsBefore)
        || existing.settingsAfterDigest !== value.settingsAfterDigest
        || existing.credentialsAfterDigest !== value.credentialsAfterDigest) throw new HostAuthorityError('conflict')
      return existing
    }
    const bytes = Buffer.from(JSON.stringify({ version: 1, ...value,
      settingsBefore: value.settingsBefore.toString('base64'),
      credentialsBefore: value.credentialsBefore.toString('base64'),
      settingsBeforeDigest: digest(value.settingsBefore), credentialsBeforeDigest: digest(value.credentialsBefore),
    }))
    this.files.replace(value.profileId, value.operationId, bytes)
    const saved = this.read(value.profileId, value.operationId)
    if (!saved || saved.operationId !== value.operationId || saved.candidateId !== value.candidateId
      || saved.targetGeneration !== value.targetGeneration
      || digest(saved.settingsBefore) !== digest(value.settingsBefore)
      || digest(saved.credentialsBefore) !== digest(value.credentialsBefore)
      || saved.settingsAfterDigest !== value.settingsAfterDigest
      || saved.credentialsAfterDigest !== value.credentialsAfterDigest) throw new HostAuthorityError('unavailable')
    return saved
  }

  /** Only known preimage/projected bytes may be restored; never erase a later personal edit. */
  restorable(input: LegacyClaimRecovery, currentSettings: Buffer, currentCredentials: Buffer): boolean {
    const settings = digest(document(currentSettings))
    const credentials = digest(document(currentCredentials))
    if (settings !== digest(input.settingsBefore) && settings !== input.settingsAfterDigest) return false
    if (credentials !== digest(input.credentialsBefore) && credentials !== input.credentialsAfterDigest) return false
    return true
  }
}
