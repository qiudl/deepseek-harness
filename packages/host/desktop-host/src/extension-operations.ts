import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validPluginPackageRecovery, type PluginPackageRecovery } from './plugin-package-recovery.ts'
import { readOwnerPrivateFile } from './private-file-io.ts'

export type ExtensionKind = 'plugin' | 'mcp' | 'skill'
/** Bounded source of the default-preset winner after removing a local Skill. */
export type SkillRemovalSource = 'absent' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | 'runtime' | 'other'
type Outcome = 'succeeded' | 'failed' | 'cancelled' | 'unknown'
/** Host-private evidence for an operation-owned Skill removal backup; contains no paths or Markdown. */
export interface SkillRemovalRecovery {
  entryId: string
  originalDigest: string
  beforeRevision: string
  removedRevision: string
  stage: 'prepared' | 'removed' | 'restored' | 'removal_verified' | 'restoration_verified'
}
/** Host-private MCP checkpoint; configuration bytes live only in the operation-owned private backup. */
export interface McpRecovery {
  beforeRevision: string
  afterRevision: string
  originalPresent: boolean
  introducedIds: string[]
  stage: 'prepared' | 'published' | 'restored' | 'application_verified' | 'restoration_verified'
}
/** Private checkpoint for configuration-only plugin activation recovery. */
export interface PluginToggleRecovery {
  packageName: string
  backupDigest: string
  beforeRevision: string
  afterRevision: string
  stage: McpRecovery['stage']
}
export interface ExtensionReceipt {
  version: 1
  operationId: string
  profileId: string
  planId: string
  kind: ExtensionKind
  digest: string
  state: 'queued' | 'running' | Outcome
  cancellationRequested: boolean
  createdAt: number
  updatedAt: number
  skillSource?: SkillRemovalSource
  pluginPackage?: PluginPackageRecovery
  recoveryMode?: 'complete'
  completedBy?: string
  canComplete?: boolean
  pluginToggleRecovery?: PluginToggleRecovery
  mcpRecovery?: McpRecovery
  skillRemoval?: SkillRemovalRecovery
  restores?: string
  restoredBy?: string
  canRestore?: boolean
  reason?: 'revision_conflict' | 'authority_revoked' | 'expired' | 'interrupted' | 'executor_failed'
}
interface Plan {
  planId: string
  profileId: string
  kind: ExtensionKind
  digest: string
  expiresAt: number
  revision: string
  payload: string
  restores?: string
  recoveryDigest?: string
  recoveryMode?: 'complete'
  scriptApproval?: { buildKey: string; digest: string; scripts: readonly { name: string; command: string }[] }
}
export interface ExtensionExecutionContext {
  kind: ExtensionKind
  operationId?: string
  buildApproval?: { buildKey: string; digest: string }
  checkpointPluginPackage?(this: void, evidence: PluginPackageRecovery): void
  checkpointPluginToggle?(this: void, evidence: PluginToggleRecovery): void
  checkpointMcp?(this: void, evidence: McpRecovery): void
  checkpointSkillRemoval?(this: void, evidence: SkillRemovalRecovery): void
  signal: AbortSignal
  guard(this: void): void
}
export interface ExtensionExecutor {
  validatePluginCompletion?(profileId: string, original: ExtensionReceipt): Promise<void>
  completePluginPackage?(profileId: string, original: ExtensionReceipt, context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']>
  validatePluginRestore?(profileId: string, original: ExtensionReceipt): Promise<void>
  restorePluginToggle?(profileId: string, original: ExtensionReceipt, context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']>
  validateMcpRestore?(profileId: string, original: ExtensionReceipt): Promise<void>
  restoreMcpConfig?(profileId: string, original: ExtensionReceipt, context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']>
  validateSkillRestore?(profileId: string, original: ExtensionReceipt): Promise<void>
  restoreSkillRemoval?(profileId: string, original: ExtensionReceipt, context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']>
  validate?(profileId: string, kind: ExtensionKind, payload: string): void
  preflight?(profileId: string, kind: ExtensionKind, payload: string): Promise<Plan['scriptApproval']>
  revision(profileId: string): Promise<string>
  execute(profileId: string, payload: string, context: ExtensionExecutionContext):
  Promise<{ state: Outcome; skillSource?: SkillRemovalSource }>
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const kinds = ['plugin', 'mcp', 'skill']
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('invalid_input')
  return value
}
/** @param input Durable metadata decoded from private storage. @returns Nothing; rejects invalid receipt fields. */
export function validateExtensionReceipt(input: unknown): asserts input is ExtensionReceipt {
  if (!input || typeof input !== 'object') throw new Error('invalid_receipt')
  const value = input as Record<string, unknown>
  uuid(value.operationId); uuid(value.profileId); uuid(value.planId)
  const keys = ['version', 'operationId', 'profileId', 'planId', 'kind', 'digest', 'state', 'cancellationRequested', 'createdAt', 'updatedAt', 'reason', 'skillSource', 'skillRemoval', 'mcpRecovery', 'pluginToggleRecovery', 'pluginPackage', 'recoveryMode', 'restores']
  if (value.restores !== undefined) {
    uuid(value.restores)
    if (typeof value.kind !== 'string' || !kinds.includes(value.kind) || value.restores === value.operationId) {
      throw Error('invalid_receipt')
    }
  }
  if (value.pluginPackage !== undefined && (value.kind !== 'plugin' || !validPluginPackageRecovery(value.pluginPackage))) throw Error('invalid_receipt')
  if (value.recoveryMode !== undefined && (value.recoveryMode !== 'complete' || value.kind !== 'plugin' || !value.restores)) throw Error('invalid_receipt')
  if (value.pluginToggleRecovery !== undefined) {
    const evidence = value.pluginToggleRecovery
    if (value.kind !== 'plugin' || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw Error('invalid_receipt')
    const row = evidence as Record<string, unknown>
    if (Object.keys(row).some(key => !['packageName', 'backupDigest', 'beforeRevision', 'afterRevision', 'stage'].includes(key))
      || typeof row.packageName !== 'string' || row.packageName.length > 214
      || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(row.packageName)
      || typeof row.stage !== 'string' || !['prepared', 'published', 'restored', 'application_verified', 'restoration_verified'].includes(row.stage)) throw Error('invalid_receipt')
    for (const key of ['backupDigest', 'beforeRevision', 'afterRevision']) {
      if (typeof row[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(row[key])) throw Error('invalid_receipt')
    }
  }
  if (value.mcpRecovery !== undefined) {
    const evidence = value.mcpRecovery
    if (value.kind !== 'mcp' || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw Error('invalid_receipt')
    const row = evidence as Record<string, unknown>
    if (Object.keys(row).some(key => !['beforeRevision', 'afterRevision', 'originalPresent', 'introducedIds', 'stage'].includes(key))
      || typeof row.originalPresent !== 'boolean' || !Array.isArray(row.introducedIds) || row.introducedIds.length > 32
      || row.introducedIds.some(id => typeof id !== 'string' || !/^mcp-[A-Za-z0-9_-]{1,32}$/u.test(id))
      || new Set(row.introducedIds).size !== row.introducedIds.length
      || typeof row.stage !== 'string' || !['prepared', 'published', 'restored', 'application_verified', 'restoration_verified'].includes(row.stage)) throw Error('invalid_receipt')
    for (const key of ['beforeRevision', 'afterRevision']) {
      if (typeof row[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(row[key])) throw Error('invalid_receipt')
    }
  }
  if (value.skillRemoval !== undefined) {
    const evidence = value.skillRemoval
    if (value.kind !== 'skill' || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw Error('invalid_receipt')
    const row = evidence as Record<string, unknown>
    if (Object.keys(row).some(key => !['entryId', 'originalDigest', 'beforeRevision', 'removedRevision', 'stage'].includes(key))
      || typeof row.entryId !== 'string' || !/^(bundle|flat)-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.entryId) || row.entryId.length > 71
      || typeof row.stage !== 'string' || !['prepared', 'removed', 'restored', 'removal_verified', 'restoration_verified'].includes(row.stage)) throw Error('invalid_receipt')
    for (const key of ['originalDigest', 'beforeRevision', 'removedRevision']) {
      if (typeof row[key] !== 'string' || !/^[0-9a-f]{64}$/u.test(row[key])) throw Error('invalid_receipt')
    }
  }
  if (Object.keys(value).some(key => !keys.includes(key)) || value.version !== 1
    || typeof value.kind !== 'string' || !kinds.includes(value.kind)
    || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(value.digest)
    || typeof value.state !== 'string' || !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(value.state)
    || typeof value.cancellationRequested !== 'boolean'
    || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt
    || (value.skillSource !== undefined && (value.kind !== 'skill' || value.state !== 'succeeded' || typeof value.skillSource !== 'string'
      || !['absent', 'user-dsh', 'user-agents', 'custom', 'bundled', 'runtime', 'other'].includes(value.skillSource)))
    || (value.reason !== undefined && (typeof value.reason !== 'string'
      || !['revision_conflict', 'authority_revoked', 'expired', 'interrupted', 'executor_failed'].includes(value.reason)))) {
    throw new Error('invalid_receipt')
  }
}

/** Private receipt persistence serialized under the single Host process lease. */
export interface ExtensionReceiptStore {
  /** @param operationId Opaque UUID. @returns Validated metadata, or undefined only when absent. */
  read(operationId: string): ExtensionReceipt | undefined
  /** @param receipt Validated metadata to atomically publish. */
  write(receipt: ExtensionReceipt): void
  /** @param profileId Authorized Profile UUID. @returns Persisted operations belonging to that Profile. */
  list(profileId: string): ExtensionReceipt[]
}

/** Private, atomically replaced receipts. One Host process owns this directory under the Host lock. */
export class FileExtensionReceipts implements ExtensionReceiptStore {
  /** @param root Host-owned private directory. @param uid Expected operating-system owner. */
  constructor(private readonly root: string, private readonly uid: number) {
    if (!existsSync(root)) mkdirSync(root, { mode: 0o700 })
    this.directory()
  }
  private directory(): void {
    const stat = lstatSync(this.root)
    if (!stat.isDirectory() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) throw new Error('unsafe_receipts')
  }
  /** @param operationId Opaque UUID. @returns Validated receipt, or undefined if absent. */
  read(operationId: string): ExtensionReceipt | undefined {
    this.directory()
    const path = join(this.root, `${uuid(operationId)}.json`)
    const bytes = readOwnerPrivateFile(path, this.uid, 65_536, () => new Error('unsafe_receipt'))
    if (bytes === undefined) return undefined
    const receipt: unknown = JSON.parse(bytes.toString('utf8'))
    validateExtensionReceipt(receipt)
    if (receipt.operationId !== operationId) throw new Error('invalid_receipt')
    return receipt
  }
  /** @param receipt Metadata only; raw installation payloads must never be stored here. */
  write(receipt: ExtensionReceipt): void {
    validateExtensionReceipt(receipt)
    if (Buffer.byteLength(JSON.stringify(receipt)) > 65_536) throw Error('invalid_receipt')
    this.directory(); this.read(receipt.operationId)
    const temp = join(this.root, `.${randomUUID()}.tmp`)
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd) } finally { closeSync(fd) }
    try {
      renameSync(temp, join(this.root, `${receipt.operationId}.json`))
      const dir = openSync(this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(dir) } finally { closeSync(dir) }
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }
  /** @param profileId Authorized Profile identifier. @returns Its persisted operations. */
  list(profileId: string): ExtensionReceipt[] {
    uuid(profileId); this.directory()
    return readdirSync(this.root).filter(name => name.endsWith('.json')).map(name => this.read(name.slice(0, -5)))
      .filter((receipt): receipt is ExtensionReceipt => receipt !== undefined && receipt.profileId === profileId)
  }
}

/** Target-bound operation owner. Call dispose and await it before releasing the Host process lock. */
export class ProfileExtensionOperations {
  private readonly plans = new Map<string, Plan>()
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly tails = new Map<string, Promise<void>>()
  private closed = false
  /** @param store Host-owned receipt store. @param executor Profile-aware executor. @param clock Host clock. */
  constructor(
    private readonly store: ExtensionReceiptStore,
    private readonly executor: ExtensionExecutor,
    private readonly clock: { now(): number },
  ) {}

  /**
   * @param authority Rechecks live Host authorization.
   * @param kind Market type.
   * @param payload Validated executor input.
   * @returns A short-lived plan without payload secrets.
   */
  async prepare(authority: () => string, kind: ExtensionKind, payload: string): Promise<Omit<Plan, 'payload'>> {
    this.assertOpen()
    const profileId = uuid(authority())
    if (!kinds.includes(kind) || typeof payload !== 'string' || !payload || Buffer.byteLength(payload) > 32_768) throw new Error('invalid_input')
    for (const [id, plan] of this.plans) if (plan.expiresAt <= this.clock.now()) this.plans.delete(id)
    if (this.plans.size >= 128) throw new Error('busy')
    let restores: string | undefined
    let recoveryDigest: string | undefined
    let recoveryMode: 'complete' | undefined
    {
      let input: { action?: unknown; operationId?: unknown } | null = null
      try { input = JSON.parse(payload) as { action?: unknown; operationId?: unknown } | null }
      catch { /* Ordinary executor payloads remain executor-owned. */ }
      const completing = kind === 'plugin' && input?.action === 'complete-package'
      if (input && (completing || input.action === (kind === 'skill' ? 'restore-removal' : kind === 'mcp' ? 'restore-config' : 'restore-toggle'))) {
        if (Object.keys(input).length !== 2) throw Error('invalid_input')
        restores = uuid(input.operationId)
        const original = this.status(authority, restores)
        if (completing) recoveryMode = 'complete'
        const evidence = completing ? original.pluginPackage : kind === 'skill' ? original.skillRemoval : kind === 'mcp' ? original.mcpRecovery : original.pluginToggleRecovery
        if (original.kind !== kind || original.state !== 'unknown' || !evidence || original.restoredBy || original.completedBy || original.restores || this.jobs.has(restores)) throw Error('invalid_input')
        const validateRestore = completing ? this.executor.validatePluginCompletion?.bind(this.executor) : kind === 'skill' ? this.executor.validateSkillRestore?.bind(this.executor) : kind === 'mcp' ? this.executor.validateMcpRestore?.bind(this.executor) : this.executor.validatePluginRestore?.bind(this.executor)
        const restore = completing ? !!this.executor.completePluginPackage : kind === 'skill' ? !!this.executor.restoreSkillRemoval
          : kind === 'mcp' ? !!this.executor.restoreMcpConfig : !!this.executor.restorePluginToggle
        if (!validateRestore || !restore) throw Error('upgrade_required')
        if (this.blocked(profileId, restores)) throw Error('busy')
        await validateRestore(profileId, original)
        recoveryDigest = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
      }
    }
    if (!restores) this.executor.validate?.(profileId, kind, payload)
    const scriptApproval = !restores ? await this.executor.preflight?.(profileId, kind, payload) : undefined
    const revision = await this.executor.revision(profileId)
    this.assertOpen()
    if (authority() !== profileId) throw new Error('unauthorized')
    if (this.plans.size >= 128) throw new Error('busy')
    const plan: Plan = { planId: randomUUID(), profileId, kind, payload, revision,
      ...(restores && recoveryDigest ? { restores, recoveryDigest } : {}),
      ...(recoveryMode ? { recoveryMode } : {}), ...(scriptApproval ? { scriptApproval } : {}),
      digest: createHash('sha256').update(JSON.stringify([profileId, kind, payload, revision,
        ...(recoveryDigest ? [recoveryDigest] : []), ...(scriptApproval ? [scriptApproval.digest] : [])])).digest('hex'), expiresAt: this.clock.now() + 300_000 }
    this.plans.set(plan.planId, plan)
    const { payload: _payload, ...result } = plan
    return result
  }
  /**
   * @param authority Live authorization callback.
   * @param planId Prepared plan.
   * @param operationId Client idempotency UUID.
   * @param signal Authenticated connection lifetime; abort stops queued and running work.
   * @returns Durably queued or existing receipt.
   */
  commit(authority: () => string, planId: string, operationId: string, signal?: AbortSignal, scriptDigest?: string): ExtensionReceipt {
    this.assertOpen(); uuid(planId); uuid(operationId)
    const profileId = uuid(authority())
    const existing = this.store.read(operationId)
    if (existing) {
      if (existing.profileId !== profileId || existing.planId !== planId) throw new Error('idempotency_conflict')
      return this.status(authority, operationId)
    }
    const plan = this.plans.get(planId)
    if (!plan || plan.profileId !== profileId) throw new Error('unauthorized')
    if (plan.expiresAt <= this.clock.now()) throw new Error('expired')
    if (plan.scriptApproval ? scriptDigest !== plan.scriptApproval.digest : scriptDigest !== undefined) {
      throw new Error('script_approval_required')
    }
    if (this.blocked(profileId, plan.restores)) throw new Error('busy')
    // One confirmation plan can produce only one operation, even with a different client UUID.
    if (this.store.list(profileId).some(receipt => receipt.planId === planId)) throw new Error('idempotency_conflict')
    const receipt: ExtensionReceipt = { version: 1, operationId, profileId, planId, kind: plan.kind, digest: plan.digest,
      ...(plan.restores ? { restores: plan.restores } : {}),
      ...(plan.recoveryMode ? { recoveryMode: plan.recoveryMode } : {}),
      state: 'queued', cancellationRequested: false, createdAt: this.clock.now(), updatedAt: this.clock.now() }
    this.store.write(receipt)
    const controller = new AbortController()
    const abort = () => { controller.abort() }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const previous = this.tails.get(profileId) ?? Promise.resolve()
    const done = previous.then(() => this.execute(authority, plan, receipt, controller)).finally(() => {
      signal?.removeEventListener('abort', abort)
      this.jobs.delete(operationId)
      this.plans.delete(planId)
    })
    this.jobs.set(operationId, { controller, done })
    // A storage failure fences subsequent work through the rejected tail; no ignored rejection.
    this.tails.set(profileId, done)
    void done.catch(() => {})
    return { ...receipt }
  }
  private async execute(authority: () => string, plan: Plan, initial: ExtensionReceipt, controller: AbortController): Promise<void> {
    const readReceipt = () => {
      const current = this.store.read(initial.operationId)
      if (!current) throw new Error('missing_receipt')
      return current
    }
    const cancelled = () => controller.signal.aborted
    let receipt = readReceipt()
    let skillSource: SkillRemovalSource | undefined
    const finish = (state: Outcome, reason?: ExtensionReceipt['reason']) => {
      receipt = { ...readReceipt(), state, updatedAt: this.clock.now(), ...(reason ? { reason } : {}), ...(state === 'succeeded' && skillSource ? { skillSource } : {}) }
      this.store.write(receipt)
    }
    if (cancelled()) { finish('cancelled'); return }
    if (this.blocked(plan.profileId, plan.restores, initial.operationId)) {
      finish('failed', 'interrupted'); return
    }
    if (plan.expiresAt <= this.clock.now()) { finish('failed', 'expired'); return }
    const guard = () => {
      if (controller.signal.aborted || authority() !== plan.profileId) throw new Error('unauthorized')
    }
    try { guard() } catch { finish('failed', 'authority_revoked'); return }
    let revision: string
    try { revision = await this.executor.revision(plan.profileId) } catch { finish('failed', 'executor_failed'); return }
    if (cancelled()) { finish('cancelled'); return }
    try { guard() } catch { finish('failed', 'authority_revoked'); return }
    if (plan.expiresAt <= this.clock.now()) { finish('failed', 'expired'); return }
    if (revision !== plan.revision) { finish('failed', 'revision_conflict'); return }
    this.store.write({ ...receipt, state: 'running', updatedAt: this.clock.now() })
    let state: Outcome
    try {
      const checkpointSkillRemoval = (evidence: SkillRemovalRecovery): void => {
        guard()
        const current = readReceipt()
        if (current.state !== 'running' || current.kind !== 'skill') throw Error('invalid_checkpoint')
        const target = JSON.parse(plan.payload) as { action?: unknown; id?: unknown } | null
        if (!target || target.action !== 'remove' || target.id !== evidence.entryId) throw Error('invalid_checkpoint')
        const previous = current.skillRemoval
        if (previous && (previous.entryId !== evidence.entryId || previous.originalDigest !== evidence.originalDigest
          || previous.beforeRevision !== evidence.beforeRevision
          || previous.removedRevision !== evidence.removedRevision)) {
          throw Error('invalid_checkpoint')
        }
        const transitions: Record<SkillRemovalRecovery['stage'], readonly SkillRemovalRecovery['stage'][]> = {
          prepared: ['removed'], removed: ['restored', 'removal_verified'], restored: ['restoration_verified'],
          removal_verified: [], restoration_verified: [],
        }
        if (previous ? !transitions[previous.stage].includes(evidence.stage) : evidence.stage !== 'prepared') throw Error('invalid_checkpoint')
        this.store.write({ ...current, skillRemoval: { ...evidence }, updatedAt: Math.max(current.updatedAt, this.clock.now()) })
      }
      const checkpointMcp = (evidence: McpRecovery): void => {
        guard()
        const current = readReceipt()
        if (current.state !== 'running' || current.kind !== 'mcp' || plan.restores) throw Error('invalid_checkpoint')
        const previous = current.mcpRecovery
        if (previous && (previous.beforeRevision !== evidence.beforeRevision || previous.afterRevision !== evidence.afterRevision
          || previous.originalPresent !== evidence.originalPresent
          || JSON.stringify(previous.introducedIds) !== JSON.stringify(evidence.introducedIds))) throw Error('invalid_checkpoint')
        const transitions: Record<McpRecovery['stage'], readonly McpRecovery['stage'][]> = {
          prepared: ['published'], published: ['restored', 'application_verified'], restored: ['restoration_verified'],
          application_verified: [], restoration_verified: [],
        }
        if (previous ? !transitions[previous.stage].includes(evidence.stage) : evidence.stage !== 'prepared') throw Error('invalid_checkpoint')
        this.store.write({ ...current, mcpRecovery: { ...evidence }, updatedAt: Math.max(current.updatedAt, this.clock.now()) })
      }
      const checkpointPluginToggle = (evidence: PluginToggleRecovery): void => {
        guard()
        const current = readReceipt()
        const input = JSON.parse(plan.payload) as { action?: unknown; packageName?: unknown }
        if (current.state !== 'running' || current.kind !== 'plugin' || plan.restores
          || input.action !== 'toggle' || input.packageName !== evidence.packageName) throw Error('invalid_checkpoint')
        const previous = current.pluginToggleRecovery
        if (previous && (previous.beforeRevision !== evidence.beforeRevision || previous.afterRevision !== evidence.afterRevision
          || previous.backupDigest !== evidence.backupDigest || previous.packageName !== evidence.packageName)) throw Error('invalid_checkpoint')
        const transitions: Record<PluginToggleRecovery['stage'], readonly PluginToggleRecovery['stage'][]> = {
          prepared: ['published'], published: ['restored', 'application_verified'], restored: ['restoration_verified'],
          application_verified: [], restoration_verified: [],
        }
        if (previous ? !transitions[previous.stage].includes(evidence.stage) : evidence.stage !== 'prepared') throw Error('invalid_checkpoint')
        this.store.write({ ...current, pluginToggleRecovery: { ...evidence }, updatedAt: Math.max(current.updatedAt, this.clock.now()) })
      }
      const checkpointPluginPackage = (evidence: PluginPackageRecovery): void => {
        guard()
        const current = readReceipt()
        if (current.kind !== 'plugin' || current.state !== 'running' || !validPluginPackageRecovery(evidence)) throw Error('invalid_checkpoint')
        const target = plan.recoveryMode === 'complete' && plan.restores ? this.store.read(plan.restores)?.pluginPackage : undefined
        const request = JSON.parse(plan.payload) as { action?: string; packageName?: string; spec?: string }
        if (plan.restores ? !target || JSON.stringify({ ...target, stage: 'prepared' }) !== JSON.stringify({ ...evidence, stage: 'prepared' })
          : (request.action ?? 'install') !== evidence.action || request.packageName !== evidence.packageName || request.spec !== evidence.spec) throw Error('invalid_checkpoint')
        const previous = current.pluginPackage
        if (previous && JSON.stringify({ ...previous, stage: 'prepared' }) !== JSON.stringify({ ...evidence, stage: 'prepared' })) throw Error('invalid_checkpoint')
        const next = previous?.stage === 'prepared' ? 'command_completed' : previous?.stage === 'command_completed' ? 'verified' : undefined
        if (previous ? evidence.stage !== next : evidence.stage !== 'prepared') throw Error('invalid_checkpoint')
        this.store.write({ ...current, pluginPackage: { ...evidence }, updatedAt: Math.max(current.updatedAt, this.clock.now()) })
      }
      const context = { kind: plan.kind, operationId: initial.operationId, checkpointSkillRemoval, checkpointMcp,
        checkpointPluginToggle, checkpointPluginPackage,
        ...(plan.scriptApproval ? { buildApproval: { buildKey: plan.scriptApproval.buildKey, digest: plan.scriptApproval.digest } } : {}),
        signal: controller.signal, guard }
      const original = plan.restores ? this.status(authority, plan.restores) : undefined
      const evidence = plan.recoveryMode === 'complete' ? original?.pluginPackage : plan.kind === 'skill' ? original?.skillRemoval : plan.kind === 'mcp' ? original?.mcpRecovery : original?.pluginToggleRecovery
      if (original && (original.kind !== plan.kind || original.state !== 'unknown' || !evidence || original.restoredBy || original.completedBy
        || createHash('sha256').update(JSON.stringify(evidence)).digest('hex') !== plan.recoveryDigest)) throw Error('invalid_recovery')
      const restore = plan.recoveryMode === 'complete' ? this.executor.completePluginPackage?.bind(this.executor) : plan.kind === 'skill'
        ? this.executor.restoreSkillRemoval?.bind(this.executor) : plan.kind === 'mcp'
          ? this.executor.restoreMcpConfig?.bind(this.executor) : this.executor.restorePluginToggle?.bind(this.executor)
      if (original && !restore) throw Error('upgrade_required')
      const result = original && restore
        ? await restore(plan.profileId, original, context)
        : await this.executor.execute(plan.profileId, plan.payload, context)
      state = result.state; skillSource = result.skillSource
      if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(state)) state = 'unknown'
    } catch { state = 'unknown' }
    finish(state, state === 'unknown' ? 'executor_failed' : undefined)
  }
  private restoredBy(receipt: ExtensionReceipt): string | undefined {
    const target = receipt.restores ?? receipt.operationId
    return this.store.list(receipt.profileId).find(item => item.restores === target && item.state === 'succeeded')?.operationId
  }
  private blocked(profileId: string, restores?: string, excluding?: string): boolean {
    return this.store.list(profileId).some((item) => {
      if (item.operationId === excluding || this.recover(item).state !== 'unknown' || this.restoredBy(item)) return false
      if (restores && (item.operationId === restores || item.restores === restores) && !this.jobs.has(item.operationId)) return false
      return true
    })
  }
  private recover(receipt: ExtensionReceipt): ExtensionReceipt {
    if ((receipt.state === 'queued' || receipt.state === 'running') && !this.jobs.has(receipt.operationId)) {
      const recovered: ExtensionReceipt = { ...receipt, state: 'unknown', reason: 'interrupted', updatedAt: Math.max(receipt.updatedAt, this.clock.now()) }
      this.store.write(recovered)
      return recovered
    }
    return receipt
  }
  /** @param authority Live Profile authorization. @param operationId Receipt UUID. @returns Profile-scoped durable outcome. */
  status(authority: () => string, operationId: string): ExtensionReceipt {
    const profileId = uuid(authority())
    const receipt = this.store.read(operationId)
    if (!receipt || receipt.profileId !== profileId) throw new Error('unauthorized')
    const current = this.recover(receipt)
    const restoredBy = current.state === 'unknown' ? this.restoredBy(current) : undefined
    const completed = restoredBy && this.store.read(restoredBy)?.recoveryMode === 'complete'
    return { ...current, ...(restoredBy ? completed ? { completedBy: restoredBy } : { restoredBy } : {}),
      ...(current.state === 'unknown' && current.pluginPackage && !current.restores && !restoredBy && !this.jobs.has(operationId)
        && this.executor.completePluginPackage ? { canComplete: true } : {}),
      ...(current.state === 'unknown' && !restoredBy && !this.jobs.has(operationId)
        && ((current.skillRemoval && this.executor.restoreSkillRemoval) || (current.mcpRecovery && this.executor.restoreMcpConfig)
          || (current.pluginToggleRecovery && this.executor.restorePluginToggle))
        ? { canRestore: true } : {}) }
  }
  /**
   * @param authority Live Profile authorization.
   * @param operationId Receipt UUID.
   * @returns Receipt with cancellation request, not a speculative terminal outcome.
   */
  cancel(authority: () => string, operationId: string): ExtensionReceipt {
    const receipt = this.status(authority, operationId)
    if (receipt.state !== 'queued' && receipt.state !== 'running') return receipt
    const updated = { ...receipt, cancellationRequested: true, updatedAt: this.clock.now() }
    this.store.write(updated)
    this.jobs.get(operationId)?.controller.abort()
    return updated
  }
  /** @returns Completion of all accepted work, including executor quiescence. */
  async settled(): Promise<void> { await Promise.all(this.tails.values()) }
  /** Abort owned work and await all effects before disposal. @returns Quiescence. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.allSettled([...this.jobs.values()].map(job => job.done))
    this.plans.clear()
  }
  private assertOpen(): void { if (this.closed) throw new Error('unavailable') }
}
