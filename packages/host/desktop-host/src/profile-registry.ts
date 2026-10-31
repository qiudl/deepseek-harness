import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountIdentity, HostClock, PersonProfileId, PersonProfileRecord } from './types.ts'
import { HostAuthorityError } from './types.ts'

interface ProfileRegistryOptions {
  readonly root: string
  readonly deviceIndexKey: Uint8Array
  readonly clock: HostClock
  readonly keyHandleUnlocked?: (keyHandle: string) => boolean
  readonly persistSnapshot?: (path: string, root: string, snapshot: RegistryFile) => void
}

interface RegistryFile { readonly version: 3; readonly profiles: readonly PersonProfileRecord[] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/

function exact(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function account(identity: AccountIdentity): AccountIdentity {
  if (identity.subject.length < 1 || identity.subject.length > 512) throw new HostAuthorityError('invalid_input')
  let issuer: URL
  try { issuer = new URL(identity.issuer) } catch { throw new HostAuthorityError('invalid_input') }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
    throw new HostAuthorityError('invalid_input')
  }
  if (issuer.pathname !== '/') throw new HostAuthorityError('invalid_input')
  return { issuer: issuer.origin, subject: identity.subject }
}

function handle(value: string): string {
  if (value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new HostAuthorityError('invalid_input')
  }
  return value
}

function parseProfile(value: unknown, legacyBindings: boolean): PersonProfileRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  const record = value as Record<string, unknown>
  if (record.kind !== 'account' && record.kind !== 'local-anonymous') throw new HostAuthorityError('unavailable')
  const keys = legacyBindings
    ? (record.kind === 'account' && record.accountBindings !== undefined
      ? ['profileId', 'kind', 'personIndex', 'keyHandle', 'accountBindings', 'bindingGeneration', 'createdAt']
      : ['profileId', 'kind', 'personIndex', 'keyHandle', 'bindingGeneration', 'createdAt'])
    : (record.kind === 'account' && record.accountBindings !== undefined
      ? ['profileId', 'kind', 'personIndex', 'keyHandle', 'unlockVerifier', 'accountBindings', 'bindingGeneration', 'createdAt']
      : ['profileId', 'kind', 'personIndex', 'keyHandle', 'unlockVerifier', 'bindingGeneration', 'createdAt'])
  if (!exact(record, keys)
    || typeof record.profileId !== 'string' || !UUID.test(record.profileId)
    || typeof record.personIndex !== 'string' || !SHA256.test(record.personIndex)
    || typeof record.keyHandle !== 'string'
    || (!legacyBindings && record.unlockVerifier !== null
      && (typeof record.unlockVerifier !== 'string' || !SHA256.test(record.unlockVerifier)))
    || !Number.isSafeInteger(record.bindingGeneration) || (record.bindingGeneration as number) < 0
    || !Number.isSafeInteger(record.createdAt) || (record.createdAt as number) < 0) {
    throw new HostAuthorityError('unavailable')
  }
  const accountBindings = record.accountBindings
  if (record.kind === 'local-anonymous' && accountBindings !== undefined) throw new HostAuthorityError('unavailable')
  if (accountBindings !== undefined && !Array.isArray(accountBindings)) throw new HostAuthorityError('unavailable')
  const parsedBindings = (accountBindings ?? []).map((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostAuthorityError('unavailable')
    const binding = value as Record<string, unknown>
    if (!exact(binding, legacyBindings
      ? ['authorityEnvironmentId', 'handle']
      : ['authorityEnvironmentId', 'handle', 'authorityBindingVersion'])
      || typeof binding.authorityEnvironmentId !== 'string' || !UUID.test(binding.authorityEnvironmentId)
      || typeof binding.handle !== 'string'
      || (!legacyBindings && (!Number.isSafeInteger(binding.authorityBindingVersion)
        || (binding.authorityBindingVersion as number) < 1))) throw new HostAuthorityError('unavailable')
    return {
      authorityEnvironmentId: binding.authorityEnvironmentId,
      handle: handle(binding.handle),
      authorityBindingVersion: legacyBindings ? 1 : binding.authorityBindingVersion as number,
    }
  })
  return {
    profileId: record.profileId as PersonProfileId,
    kind: record.kind,
    personIndex: record.personIndex,
    keyHandle: handle(record.keyHandle),
    unlockVerifier: legacyBindings ? null : record.unlockVerifier as string | null,
    ...(record.kind === 'account' ? { accountBindings: parsedBindings } : {}),
    bindingGeneration: record.bindingGeneration as number,
    createdAt: record.createdAt as number,
  }
}

/**
 * Compute the non-reversible, issuer-qualified index stored in the Profile registry.
 * @param deviceIndexKey - installation-local 32-byte HMAC key.
 * @param identity - issuer-qualified account identity.
 * @returns lower-case HMAC-SHA-256 index.
 */
export function personIndex(deviceIndexKey: Uint8Array, identity: AccountIdentity): string {
  if (deviceIndexKey.byteLength !== 32) throw new HostAuthorityError('invalid_input')
  const normalized = account(identity)
  return createHmac('sha256', deviceIndexKey)
    .update('dsh-person-profile-index/v1\0')
    .update(normalized.issuer)
    .update('\0')
    .update(normalized.subject)
    .digest('hex')
}

function unlockMaterial(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new HostAuthorityError('invalid_input')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) throw new HostAuthorityError('invalid_input')
  return decoded
}

/** Durable registry that stores only HMAC account indexes and Keychain handles. */
export class ProfileRegistry {
  private readonly path: string
  private profiles: PersonProfileRecord[]

  constructor(private readonly options: ProfileRegistryOptions) {
    if (options.deviceIndexKey.byteLength !== 32) throw new HostAuthorityError('invalid_input')
    mkdirSync(options.root, { recursive: true, mode: 0o700 })
    const root = lstatSync(options.root)
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== (process.getuid?.() ?? root.uid) || (root.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
    this.path = join(options.root, 'profiles.json')
    this.profiles = this.load()
  }

  /**
   * Register or resolve one issuer-qualified DSH Account Profile.
   * @param input - account identity plus opaque Keychain and binding handles.
   * @returns the durable account Profile.
   */
  async registerAccount(
    input: AccountIdentity & {
      readonly keyHandle: string
      readonly authorityEnvironmentId?: string
      readonly accountBindingHandle?: string
      readonly authorityBindingVersion?: number
      readonly unlockMaterial: string
    },
  ): Promise<PersonProfileRecord> {
    await Promise.resolve()
    const index = personIndex(this.options.deviceIndexKey, input)
    const material = unlockMaterial(input.unlockMaterial)
    const existing = this.profiles.find(profile => profile.personIndex === index)
    if ((input.authorityEnvironmentId === undefined) !== (input.accountBindingHandle === undefined)
      || (input.accountBindingHandle === undefined) !== (input.authorityBindingVersion === undefined)) {
      throw new HostAuthorityError('invalid_input')
    }
    const binding = input.accountBindingHandle === undefined ? undefined : {
      authorityEnvironmentId: input.authorityEnvironmentId as string,
      handle: handle(input.accountBindingHandle),
      authorityBindingVersion: input.authorityBindingVersion as number,
    }
    if (binding !== undefined && (!UUID.test(binding.authorityEnvironmentId)
      || !Number.isSafeInteger(binding.authorityBindingVersion) || binding.authorityBindingVersion < 1)) {
      throw new HostAuthorityError('invalid_input')
    }
    const bindingOwner = binding === undefined ? undefined : this.profiles.find(profile =>
      profile.accountBindings?.some(candidate => candidate.authorityEnvironmentId === binding.authorityEnvironmentId
        && candidate.handle === binding.handle),
    )
    if (bindingOwner !== undefined && bindingOwner.personIndex !== index) {
      throw new HostAuthorityError('profile_mismatch')
    }
    if (existing) {
      if (existing.kind !== 'account') throw new HostAuthorityError('profile_mismatch')
      if (existing.keyHandle !== handle(input.keyHandle)) throw new HostAuthorityError('profile_mismatch')
      const verifier = this.unlockVerifier(existing.profileId, existing.keyHandle, material)
      if (existing.unlockVerifier !== null
        && !timingSafeEqual(Buffer.from(existing.unlockVerifier, 'hex'), Buffer.from(verifier, 'hex'))) {
        throw new HostAuthorityError('unauthorized')
      }
      let currentProfile = existing
      if (existing.unlockVerifier === null) {
        currentProfile = { ...existing, unlockVerifier: verifier, bindingGeneration: existing.bindingGeneration + 1 }
      }
      if (binding === undefined) {
        if (currentProfile === existing) return existing
        const next = this.profiles.map(profile => profile.profileId === existing.profileId ? currentProfile : profile)
        this.save(next); this.profiles = next
        return currentProfile
      }
      const current = currentProfile.accountBindings?.find(candidate =>
        candidate.authorityEnvironmentId === binding.authorityEnvironmentId)
      if (current !== undefined) {
        if (binding.authorityBindingVersion < current.authorityBindingVersion) throw new HostAuthorityError('stale')
        if (binding.authorityBindingVersion === current.authorityBindingVersion) {
          if (binding.handle !== current.handle) throw new HostAuthorityError('conflict')
          if (currentProfile === existing) return existing
          const next = this.profiles.map(profile => profile.profileId === existing.profileId ? currentProfile : profile)
          this.save(next); this.profiles = next
          return currentProfile
        }
      }
      const updated = {
        ...currentProfile,
        accountBindings: [...currentProfile.accountBindings?.filter(candidate =>
          candidate.authorityEnvironmentId !== binding.authorityEnvironmentId) ?? [], binding],
        bindingGeneration: currentProfile.bindingGeneration + 1,
      }
      const next = this.profiles.map(profile => profile.profileId === existing.profileId ? updated : profile)
      this.save(next)
      this.profiles = next
      return updated
    }
    const profileId = randomUUID() as PersonProfileId
    const keyHandle = handle(input.keyHandle)
    const profile: PersonProfileRecord = {
      profileId,
      kind: 'account',
      personIndex: index,
      keyHandle,
      unlockVerifier: this.unlockVerifier(profileId, keyHandle, material),
      accountBindings: binding === undefined ? [] : [binding],
      bindingGeneration: binding === undefined ? 0 : 1,
      createdAt: this.options.clock.now(),
    }
    const next = [...this.profiles, profile]
    this.save(next)
    this.profiles = next
    return profile
  }

  /**
   * Create a Profile that can never be merged into an account Profile.
   * @param input - opaque Keychain handle for the local Profile key.
   * @returns the new durable local-anonymous Profile.
   */
  async createLocalAnonymous(input: { readonly keyHandle: string }): Promise<PersonProfileRecord> {
    await Promise.resolve()
    const profile: PersonProfileRecord = {
      profileId: randomUUID() as PersonProfileId,
      kind: 'local-anonymous',
      personIndex: createHmac('sha256', this.options.deviceIndexKey).update(`dsh-local-anonymous/v1\0${randomUUID()}`).digest('hex'),
      keyHandle: handle(input.keyHandle),
      unlockVerifier: null,
      bindingGeneration: 0,
      createdAt: this.options.clock.now(),
    }
    const next = [...this.profiles, profile]
    this.save(next)
    this.profiles = next
    return profile
  }

  /**
   * Reject account binding for local-anonymous Profiles; migration creates a separate account Profile.
   * @param profileId - Profile selected for the prohibited rebind.
   * @param _identity - account identity that must instead create a distinct Profile.
   * @returns a rejected Promise; rebinding is never permitted.
   */
  async bindAccount(profileId: PersonProfileId, _identity: AccountIdentity): Promise<never> {
    await Promise.resolve()
    const profile = this.profiles.find(candidate => candidate.profileId === profileId)
    if (!profile || profile.kind === 'local-anonymous') throw new HostAuthorityError('profile_mismatch')
    throw new HostAuthorityError('conflict')
  }

  /**
   * Resolve an account without persisting its raw issuer or subject.
   * @param identity - issuer-qualified account identity.
   * @returns the matching Profile or null.
   */
  async resolveAccount(identity: AccountIdentity): Promise<PersonProfileRecord | null> {
    await Promise.resolve()
    const index = personIndex(this.options.deviceIndexKey, identity)
    return this.profiles.find(profile => profile.kind === 'account' && profile.personIndex === index) ?? null
  }

  /**
   * Resolve the secure local binding selected by Desktop Main.
   * @param authorityEnvironmentId - globally stable authority environment UUID.
   * @param accountBindingHandle - opaque binding minted outside Renderer.
   * @param authorityBindingVersion - monotonic authority binding version.
   * @returns the matching account Profile or null.
   */
  resolveBinding(
    authorityEnvironmentId: string,
    accountBindingHandle: string,
    authorityBindingVersion: number,
  ): PersonProfileRecord | null {
    if (!UUID.test(authorityEnvironmentId)) throw new HostAuthorityError('invalid_input')
    if (!Number.isSafeInteger(authorityBindingVersion) || authorityBindingVersion < 1) {
      throw new HostAuthorityError('invalid_input')
    }
    const binding = handle(accountBindingHandle)
    return this.profiles.find(profile => profile.kind === 'account' && profile.accountBindings?.some(candidate =>
      candidate.authorityEnvironmentId === authorityEnvironmentId && candidate.handle === binding
      && candidate.authorityBindingVersion === authorityBindingVersion)) ?? null
  }

  /**
   * Report only whether the embedding Keychain resolver currently holds this Profile unlock handle.
   * @param profile - Profile whose opaque key handle is resolved.
   * @returns whether its key is currently unlocked.
   */
  isUnlocked(profile: PersonProfileRecord): boolean { return this.options.keyHandleUnlocked?.(profile.keyHandle) ?? false }

  /**
   * Verify Main-vault material without persisting or returning it.
   * @param profile - Profile holding the verifier.
   * @param keyHandle - opaque Main-vault key handle.
   * @param material - connection-bound unlock material.
   */
  verifyUnlock(profile: PersonProfileRecord, keyHandle: string, material: string): void {
    if (profile.keyHandle !== handle(keyHandle) || profile.unlockVerifier === null) {
      throw new HostAuthorityError('unauthorized')
    }
    const expected = this.unlockVerifier(profile.profileId, profile.keyHandle, unlockMaterial(material))
    if (!timingSafeEqual(Buffer.from(profile.unlockVerifier, 'hex'), Buffer.from(expected, 'hex'))) {
      throw new HostAuthorityError('unauthorized')
    }
  }

  private unlockVerifier(profileId: PersonProfileId, keyHandle: string, material: Uint8Array): string {
    return createHmac('sha256', this.options.deviceIndexKey)
      .update('dsh-profile-unlock-verifier/v1\0').update(profileId).update('\0').update(keyHandle).update('\0')
      .update(material).digest('hex')
  }

  /**
   * Snapshot Profiles whose opaque key handles are currently unlocked.
   * @returns immutable registry rows for startup worker composition.
   */
  listUnlocked(): readonly PersonProfileRecord[] {
    return this.profiles.filter(profile => this.isUnlocked(profile))
  }

  /**
   * Resolve an opaque Profile id for signed-selector restoration.
   * @param profileId - opaque Profile id.
   * @returns the matching Profile or null.
   */
  resolveProfile(profileId: PersonProfileId): PersonProfileRecord | null {
    return this.profiles.find(profile => profile.profileId === profileId) ?? null
  }

  /**
   * Remove a newly registered Profile when its first worker cannot start.
   * @param profileId - unexposed Profile whose provisioning transaction rolls back.
   */
  rollbackRegistration(profileId: PersonProfileId): void {
    const next = this.profiles.filter(profile => profile.profileId !== profileId)
    if (next.length === this.profiles.length) throw new HostAuthorityError('stale')
    this.save(next)
    this.profiles = next
  }

  /**
   * Restore the prior row after a failed worker start following a binding update.
   * @param current - failed current registry row.
   * @param previous - prior registry row to restore.
   */
  rollbackUpdate(current: PersonProfileRecord, previous: PersonProfileRecord): void {
    const stored = this.profiles.find(profile => profile.profileId === current.profileId)
    if (!stored || stored.bindingGeneration !== current.bindingGeneration
      || previous.profileId !== current.profileId) throw new HostAuthorityError('stale')
    const next = this.profiles.map(profile => profile.profileId === current.profileId ? previous : profile)
    this.save(next)
    this.profiles = next
  }

  private load(): PersonProfileRecord[] {
    let fd: number
    try { fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new HostAuthorityError('unavailable')
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== (process.getuid?.() ?? stat.uid) || (stat.mode & 0o077) !== 0) throw new HostAuthorityError('unavailable')
      const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HostAuthorityError('unavailable')
      const registry = parsed as Record<string, unknown>
      if (!exact(registry, ['version', 'profiles'])
        || (registry.version !== 2 && registry.version !== 3) || !Array.isArray(registry.profiles)) {
        throw new HostAuthorityError('unavailable')
      }
      const legacyBindings = registry.version === 2
      const profiles = registry.profiles.map(profile => parseProfile(profile, legacyBindings))
      const profileIds = new Set<string>()
      const indexes = new Set<string>()
      const bindings = new Set<string>()
      const environments = new Set<string>()
      for (const profile of profiles) {
        if (profileIds.has(profile.profileId) || indexes.has(profile.personIndex)
          || profile.accountBindings?.some(binding => bindings.has(`${binding.authorityEnvironmentId}\0${binding.handle}`)
            || environments.has(`${profile.profileId}\0${binding.authorityEnvironmentId}`))) {
          throw new HostAuthorityError('unavailable')
        }
        profileIds.add(profile.profileId); indexes.add(profile.personIndex)
        for (const binding of profile.accountBindings ?? []) {
          bindings.add(`${binding.authorityEnvironmentId}\0${binding.handle}`)
          environments.add(`${profile.profileId}\0${binding.authorityEnvironmentId}`)
        }
      }
      if (legacyBindings) this.save(profiles)
      return profiles
    } catch (error) {
      if (error instanceof HostAuthorityError) throw error
      throw new HostAuthorityError('unavailable')
    } finally { closeSync(fd) }
  }

  private save(profiles: readonly PersonProfileRecord[]): void {
    const snapshot = { version: 3 as const, profiles }
    if (this.options.persistSnapshot) { this.options.persistSnapshot(this.path, this.options.root, snapshot); return }
    const temporary = join(this.options.root, `.profiles-${randomUUID()}.tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeSync(fd, `${JSON.stringify(snapshot satisfies RegistryFile)}\n`)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temporary, this.path)
    const rootFd = openSync(this.options.root, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(rootFd) } finally { closeSync(rootFd) }
  }
}
