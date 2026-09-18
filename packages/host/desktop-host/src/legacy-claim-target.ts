import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { LegacyClaimRecoveryStore, type LegacyClaimRecovery } from './legacy-claim-recovery.ts'
import { projectLegacyModelClaim } from './legacy-claim-projection.ts'
import { HostAuthorityError } from './types.ts'

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true })

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('invalid_input')
  return value as Record<string, unknown>
}

function parse(bytes: Buffer): Record<string, unknown> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_DOCUMENT_BYTES) {
    throw new HostAuthorityError('unavailable')
  }
  let parsed
  try { parsed = parseDocument(UTF8.decode(bytes), { prettyErrors: false, uniqueKeys: true }) }
  catch { throw new HostAuthorityError('unavailable') }
  if (parsed.errors.length > 0) throw new HostAuthorityError('unavailable')
  return object(parsed.toJS())
}

function credentials(bytes: Buffer): { refs: Record<string, unknown>; records: Record<string, unknown> } {
  const value = parse(bytes)
  if (value.version !== 1 || Object.keys(value).sort().join(',') !== 'records,refs,version') {
    throw new HostAuthorityError('unavailable')
  }
  return { refs: object(value.refs), records: object(value.records) }
}

function encode(value: Record<string, unknown>): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new HostAuthorityError('invalid_input')
  return bytes
}

/** Current mutable documents for one authorized, quiesced Profile generation. */
export interface LegacyClaimTargetFiles {
  read(kind: 'settings' | 'credentials'): Buffer
  replace(kind: 'settings' | 'credentials', bytes: Buffer): void
}

export interface PreparedLegacyClaimTarget {
  readonly recovery: LegacyClaimRecovery
  readonly settingsAfter: Buffer
  readonly credentialsAfter: Buffer
}

/** Applies one projected provider to a worker-fenced Profile and verifies both live documents. */
export class LegacyClaimTarget {
  constructor(private readonly files: LegacyClaimTargetFiles, private readonly recovery: LegacyClaimRecoveryStore) {}

  /** Persist the original target pair before either document can change. */
  prepare(input: {
    readonly profileId: string
    readonly candidateId: string
    readonly operationId: string
    readonly targetGeneration: number
    readonly sourceSettings: unknown
    readonly sourceCredentials: unknown
    readonly guard: () => void
  }): PreparedLegacyClaimTarget {
    input.guard()
    const currentSettings = this.files.read('settings')
    const currentCredentials = this.files.read('credentials')
    const existing = this.recovery.read(input.profileId, input.operationId)
    if (existing && (!this.recovery.restorable(existing, currentSettings, currentCredentials)
      || existing.candidateId !== input.candidateId || existing.targetGeneration !== input.targetGeneration)) {
      throw new HostAuthorityError('conflict')
    }
    const settingsBefore = existing?.settingsBefore ?? currentSettings
    const credentialsBefore = existing?.credentialsBefore ?? currentCredentials
    const projected = projectLegacyModelClaim({
      candidateId: input.candidateId, profileId: input.profileId, operationId: input.operationId,
      sourceSettings: input.sourceSettings, sourceCredentials: input.sourceCredentials,
      targetSettings: parse(settingsBefore), targetCredentials: credentials(credentialsBefore),
    })
    const settingsAfter = encode(projected.settings)
    const credentialsAfter = encode({ version: 1, ...projected.credentials })
    input.guard()
    const recovery = this.recovery.prepare({
      profileId: input.profileId, candidateId: input.candidateId, operationId: input.operationId,
      targetGeneration: input.targetGeneration, settingsBefore, credentialsBefore,
      settingsAfter, credentialsAfter,
    })
    return { recovery, settingsAfter, credentialsAfter }
  }

  /** Rechecks each document before replacing it, then verifies the complete projected pair. */
  publish(prepared: PreparedLegacyClaimTarget, guard: () => void): void {
    const { recovery, settingsAfter, credentialsAfter } = prepared
    this.assertPrepared(prepared)
    for (const [kind, before, after] of [
      ['credentials', recovery.credentialsBefore, credentialsAfter],
      ['settings', recovery.settingsBefore, settingsAfter],
    ] as const) {
      guard()
      const current = this.files.read(kind)
      if (current.equals(after)) continue
      if (!current.equals(before)) throw new HostAuthorityError('conflict')
      guard()
      this.files.replace(kind, after)
    }
    guard()
    if (!this.files.read('settings').equals(settingsAfter)
      || !this.files.read('credentials').equals(credentialsAfter)) throw new HostAuthorityError('unavailable')
    parse(settingsAfter)
    credentials(credentialsAfter)
  }

  /** Restore only a complete preimage/projected pair; a later edit is never overwritten. */
  restore(recovery: LegacyClaimRecovery, guard: () => void): void {
    this.assertRecovery(recovery)
    guard()
    const settings = this.files.read('settings')
    const credentialBytes = this.files.read('credentials')
    if (!this.recovery.restorable(recovery, settings, credentialBytes)) throw new HostAuthorityError('conflict')
    for (const [kind, before] of [
      ['credentials', recovery.credentialsBefore], ['settings', recovery.settingsBefore],
    ] as const) {
      guard()
      const current = this.files.read(kind)
      if (current.equals(before)) continue
      if (!this.recovery.restorable(recovery, this.files.read('settings'), this.files.read('credentials'))) {
        throw new HostAuthorityError('conflict')
      }
      guard()
      this.files.replace(kind, before)
    }
    guard()
    if (!this.files.read('settings').equals(recovery.settingsBefore)
      || !this.files.read('credentials').equals(recovery.credentialsBefore)) throw new HostAuthorityError('unavailable')
  }

  private assertPrepared(prepared: PreparedLegacyClaimTarget): void {
    this.assertRecovery(prepared.recovery)
    if (digest(prepared.settingsAfter) !== prepared.recovery.settingsAfterDigest
      || digest(prepared.credentialsAfter) !== prepared.recovery.credentialsAfterDigest) {
      throw new HostAuthorityError('unavailable')
    }
  }

  private assertRecovery(recovery: LegacyClaimRecovery): void {
    const durable = this.recovery.read(recovery.profileId, recovery.operationId)
    if (!durable || durable.candidateId !== recovery.candidateId
      || durable.targetGeneration !== recovery.targetGeneration
      || durable.settingsAfterDigest !== recovery.settingsAfterDigest
      || durable.credentialsAfterDigest !== recovery.credentialsAfterDigest
      || !durable.settingsBefore.equals(recovery.settingsBefore)
      || !durable.credentialsBefore.equals(recovery.credentialsBefore)) throw new HostAuthorityError('unavailable')
  }
}
