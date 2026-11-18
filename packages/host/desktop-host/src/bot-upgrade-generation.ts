import { ProfileUpgradeFailure } from './profile-upgrade-failure.ts'
import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { assertPrivateTreeFilesPreserved, capturePluginTree, materializePrivateTreeSnapshot, privateTreeSnapshotFile, privateTreeSnapshotIsEmpty } from './plugin-tree-snapshot.ts'
import { assertBotUpgradePreserved, inspectBotUpgradeState, type BotUpgradeState } from './bot-upgrade-state.ts'
import { readOwnerPrivateFile } from './private-file-io.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const digest = /^[0-9a-f]{64}$/u
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
type Manifest = Readonly<{
  version: 1
  operationId: string
  profile: string
  source: string
  sourcePresent: boolean
  snapshotDigest: string
}>
/** Verified immutable backup identity and unpublished Bot Home; activation requires the enclosing operation. */
export type BotUpgradeGeneration = Readonly<{
  operationId: string
  candidateHome: string
  snapshotDigest: string
  source: BotUpgradeState
}>

/** Immutable Bot Home backup and unpublished candidate; activation belongs to the governed transaction. */
export class BotUpgradeGenerations {
  private readonly profile: string
  /**
   * @param profileRoot Canonical owner-private Profile directory.
   * @param controlRoot Existing owner-private directory for immutable operation evidence.
   * @param uid Expected filesystem owner.
   * @param source Relative Bot Home generation; omitted means the original `bot` directory.
   */
  constructor(private readonly profileRoot: string, private readonly controlRoot: string,
    private readonly uid: number, private readonly source = 'bot') {
    this.directory(profileRoot, true)
    this.directory(controlRoot, true)
    if (source !== 'bot' && !/^bot-upgrades\/[0-9a-f-]{36}$/u.test(source)) throw new ProfileUpgradeFailure('unsafe_bot_upgrade_source')
    if (source !== 'bot' && !uuid.test(source.slice('bot-upgrades/'.length))) throw new ProfileUpgradeFailure('unsafe_bot_upgrade_source')
    this.profile = hash(profileRoot)
  }
  private directory(path: string, privateMode: boolean): void {
    const stat = lstatSync(path)
    if (!isAbsolute(path) || realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== this.uid || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0) throw new ProfileUpgradeFailure('unsafe_bot_upgrade_directory')
  }
  private paths(operationId: string) {
    if (!uuid.test(operationId)) throw new ProfileUpgradeFailure('invalid_bot_upgrade_operation')
    this.directory(this.profileRoot, true); this.directory(this.controlRoot, true)
    return { metadata: join(this.controlRoot, `${operationId}.json`), snapshot: join(this.controlRoot, `${operationId}.snapshot`),
      candidates: join(this.profileRoot, 'bot-upgrades'), candidateHome: join(this.profileRoot, 'bot-upgrades', operationId) }
  }
  private sourceSnapshot(): { present: boolean; bytes?: Buffer; digest: string; state: BotUpgradeState } {
    const path = join(this.profileRoot, ...this.source.split('/'))
    if (!lstatSync(path, { throwIfNoEntry: false })) return { present: false, digest: hash('absent'), state: inspectBotUpgradeState(undefined) }
    this.directory(path, false)
    if (lstatSync(join(path, 'state.lock'), { throwIfNoEntry: false })) throw new ProfileUpgradeFailure('bot_upgrade_writer_not_quiescent')
    const snapshot = capturePluginTree(path, this.uid)
    const state = privateTreeSnapshotFile(snapshot.bytes, snapshot.digest, 'state.json')
    if (state === undefined && !privateTreeSnapshotIsEmpty(snapshot.bytes, snapshot.digest)) throw new ProfileUpgradeFailure('bot_upgrade_schema_unsupported')
    return { present: true, ...snapshot, state: inspectBotUpgradeState(state) }
  }
  private writeExclusive(path: string, bytes: Buffer): void {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    const parent = openSync(this.controlRoot, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(parent) } finally { closeSync(parent) }
  }
  /**
   * Copy only after live writer quiescence. Invalid data fails before creating any candidate or backup.
   * @param operationId Original Host operation identity, reused for retries.
   * @param guard Caller-owned authorization and quiescence assertion.
   * @returns Immutable source evidence and the unpublished candidate location.
   */
  prepare(operationId: string, guard: () => void): BotUpgradeGeneration {
    guard()
    const paths = this.paths(operationId)
    const source = this.sourceSnapshot()
    guard()
    if (existsSync(paths.metadata)) {
      const retained = this.read(operationId)
      if (retained.snapshotDigest !== source.digest) throw new ProfileUpgradeFailure('bot_upgrade_source_changed')
      return retained
    }
    if (source.bytes) this.writeExclusive(paths.snapshot, source.bytes)
    guard()
    if (!existsSync(paths.candidates)) mkdirSync(paths.candidates, { mode: 0o700 })
    this.directory(paths.candidates, true)
    if (source.bytes) materializePrivateTreeSnapshot(paths.candidateHome, source.bytes, source.digest, this.uid, guard)
    else { guard(); mkdirSync(paths.candidateHome, { mode: 0o700 }) }
    guard()
    if (this.sourceSnapshot().digest !== source.digest) throw new ProfileUpgradeFailure('bot_upgrade_source_changed')
    const metadata: Manifest = { version: 1, operationId, profile: this.profile, source: this.source,
      sourcePresent: source.present, snapshotDigest: source.digest }
    this.writeExclusive(paths.metadata, Buffer.from(JSON.stringify(metadata)))
    return { operationId, candidateHome: paths.candidateHome, snapshotDigest: source.digest, source: source.state }
  }
  /**
   * Read only operation-owned immutable evidence; neither an operation ID nor a path is public authority.
   * @param operationId Original Host operation identity.
   * @returns Verified source evidence and its existing candidate location.
   */
  read(operationId: string): BotUpgradeGeneration {
    const paths = this.paths(operationId)
    const bytes = readOwnerPrivateFile(paths.metadata, this.uid, 4096, () => new ProfileUpgradeFailure('invalid_bot_upgrade_backup'))
    if (!bytes) throw new ProfileUpgradeFailure('bot_upgrade_backup_missing')
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProfileUpgradeFailure('invalid_bot_upgrade_backup')
    const value = raw as Record<string, unknown>
    if (Object.keys(value).sort().join(',') !== 'operationId,profile,snapshotDigest,source,sourcePresent,version'
      || value.version !== 1 || value.operationId !== operationId || value.profile !== this.profile || value.source !== this.source
      || typeof value.sourcePresent !== 'boolean' || typeof value.snapshotDigest !== 'string'
      || !digest.test(value.snapshotDigest)) throw new ProfileUpgradeFailure('invalid_bot_upgrade_backup')
    let state: BotUpgradeState
    if (value.sourcePresent) {
      const snapshot = readOwnerPrivateFile(paths.snapshot, this.uid, 24 * 1024 * 1024, () => new ProfileUpgradeFailure('invalid_bot_upgrade_backup'))
      if (!snapshot || hash(snapshot) !== value.snapshotDigest) throw new ProfileUpgradeFailure('invalid_bot_upgrade_backup')
      const stateBytes = privateTreeSnapshotFile(snapshot, value.snapshotDigest, 'state.json')
      if (stateBytes === undefined && !privateTreeSnapshotIsEmpty(snapshot, value.snapshotDigest)) throw new ProfileUpgradeFailure('invalid_bot_upgrade_backup')
      state = inspectBotUpgradeState(stateBytes)
    } else {
      if (value.snapshotDigest !== hash('absent')) throw new ProfileUpgradeFailure('invalid_bot_upgrade_backup')
      state = inspectBotUpgradeState(undefined)
    }
    this.directory(paths.candidates, true); this.directory(paths.candidateHome, false)
    return { operationId, candidateHome: paths.candidateHome, snapshotDigest: value.snapshotDigest, source: state }
  }
  /**
   * Reject loss in the isolated target result; the source directory is never rewritten by this component.
   * @param operationId Original Host operation identity.
   * @returns Verified evidence after checking source stability and candidate preservation.
   */
  verifyCandidate(operationId: string): BotUpgradeGeneration {
    const plan = this.read(operationId)
    const current = this.sourceSnapshot()
    if (current.digest !== plan.snapshotDigest) throw new ProfileUpgradeFailure('bot_upgrade_source_changed')
    const snapshot = capturePluginTree(plan.candidateHome, this.uid)
    const candidate = inspectBotUpgradeState(privateTreeSnapshotFile(snapshot.bytes, snapshot.digest, 'state.json'))
    assertBotUpgradePreserved(plan.source, candidate)
    const paths = this.paths(operationId)
    const original = readOwnerPrivateFile(paths.snapshot, this.uid, 24 * 1024 * 1024, () => new ProfileUpgradeFailure('invalid_bot_upgrade_backup'))
    if (original) assertPrivateTreeFilesPreserved(original, plan.snapshotDigest, snapshot.bytes, snapshot.digest, ['state.json'])
    return plan
  }
}
