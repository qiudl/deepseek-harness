import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseSkillFile, renderSkillFile, setInvocation } from '#hub-skills'
import type { ExtensionExecutor, ExtensionReceipt, ExtensionKind, SkillRemovalSource, SkillRemovalRecovery } from './extension-operations.ts'
import { archiveSource, downloadSkillArchive, type SkillArchiveSource } from './skill-archive-download.ts'
import { inspectSkillArchive, type SkillArchiveFile } from './skill-archive.ts'
import { skillInventory, type SkillInventoryEntry } from './skill-inventory.ts'
import { verifySkillRuntime } from './skill-runtime-ack.ts'

interface ProfileSkillExecutorOptions {
  profileRoot(profileId: string): string
  uid: number
  catalog?(profileId: string, signal: AbortSignal): Promise<unknown>
  acknowledge(profileId: string, name: string, content: string, signal: AbortSignal, guard: () => void): Promise<unknown>
}
interface SkillInput {
  name: string
  description: string
  body: string
  modelInvocable: boolean
  userInvocable: boolean
  whenToUse?: string
}
interface InvocationInput { action: 'invocation'; id: string; kind: 'model' | 'user'; value: boolean }
const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
interface ReplacementInput { action: 'replace'; id: string; markdown: string }
interface RemovalInput { action: 'remove'; id: string }
type SkillRequest = RemovalInput | ReplacementInput | InvocationInput | SkillInput
  | { name: string; markdown: string } | { name: string; archive: SkillArchiveSource }
function input(payload: string): SkillRequest {
  const value: unknown = JSON.parse(payload)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input')
  const v = value as Record<string, unknown>
  if (v.action === 'remove') {
    if (Object.keys(v).length !== 2 || typeof v.id !== 'string' || !/^(bundle|flat)-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(v.id)
      || v.id.length > 71) throw Error('invalid_input')
    return { action: 'remove', id: v.id }
  }
  if (v.action === 'replace') {
    if (Object.keys(v).length !== 3 || typeof v.id !== 'string' || !/^(bundle|flat)-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(v.id)
      || v.id.length > 71 || typeof v.markdown !== 'string') throw Error('invalid_input')
    input(JSON.stringify({ name: v.id.replace(/^(bundle|flat)-/u, ''), markdown: v.markdown }))
    return { action: 'replace', id: v.id, markdown: v.markdown }
  }
  if (v.action === 'invocation') {
    if (Object.keys(v).length !== 4 || typeof v.id !== 'string' || !/^(bundle|flat)-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(v.id)
      || v.id.length > 71 || !['model', 'user'].includes(String(v.kind)) || typeof v.value !== 'boolean') throw Error('invalid_input')
    return { action: 'invocation', id: v.id, kind: v.kind as 'model' | 'user', value: v.value }
  }
  if (Object.hasOwn(v, 'markdown')) {
    if (Object.keys(v).length !== 2 || typeof v.name !== 'string' || v.name.length > 64 || !skillName.test(v.name)
      || typeof v.markdown !== 'string' || v.markdown.includes('\0') || Buffer.byteLength(v.markdown) > 32768) throw Error('invalid_input')
    const { meta, body } = parseSkillFile(v.markdown)
    if (meta.name !== v.name || typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 1024
      || !body.trim() || Buffer.byteLength(body) > 24576
      || 'whenToUse' in meta && (typeof meta.whenToUse !== 'string' || meta.whenToUse.length > 1024)
      || ['disable-model-invocation', 'user-invocable'].some(key => key in meta && typeof meta[key] !== 'boolean')) throw Error('invalid_input')
    return { name: v.name, markdown: v.markdown }
  }
  if (Object.keys(v).length === 2 && typeof v.name === 'string' && v.name.length <= 64 && skillName.test(v.name) && Object.hasOwn(v, 'archive')) {
    return { name: v.name, archive: archiveSource(v.archive) }
  }
  if (Object.keys(v).length !== (Object.hasOwn(v, 'whenToUse') ? 6 : 5) || typeof v.name !== 'string' || v.name.length > 64 || !skillName.test(v.name)
    || typeof v.description !== 'string' || !v.description.trim() || v.description.length > 1024
    || typeof v.body !== 'string' || !v.body.trim() || Buffer.byteLength(v.body) > 24576
    || typeof v.modelInvocable !== 'boolean' || typeof v.userInvocable !== 'boolean'
    || Object.hasOwn(v, 'whenToUse') && (typeof v.whenToUse !== 'string' || v.whenToUse.length > 1024 || v.whenToUse.includes('\0'))
    || [v.name, v.description, v.body].some(text => text.includes('\0'))) throw new Error('invalid_input')
  return { name: v.name, description: v.description, body: v.body, modelInvocable: v.modelInvocable, userInvocable: v.userInvocable,
    ...(typeof v.whenToUse === 'string' ? { whenToUse: v.whenToUse } : {}) }
}

/** Creates and edits Profile-local skills; success requires runtime acknowledgement. */
export class ProfileSkillExecutor implements ExtensionExecutor {
  /** @param options Host-owned target resolver and runtime acknowledgement callback. */
  constructor(private readonly options: ProfileSkillExecutorOptions) {}
  private directory(path: string): void {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.uid !== this.options.uid || (stat.mode & 0o022) !== 0) throw new Error('unsafe_skill_root')
  }
  private root(profileId: string): string {
    const root = this.options.profileRoot(profileId)
    this.directory(root)
    return root
  }
  private treeDigest(root: string): string {
    const hash = createHash('sha256'); let files = 0; let bytes = 0
    const visit = (path: string, relative: string): void => {
      this.directory(path)
      for (const name of readdirSync(path).sort()) {
        if (++files > 512) throw Error('skill_limit')
        const child = join(path, name); const stat = lstatSync(child); const key = `${relative}/${name}`
        if (stat.isDirectory()) { visit(child, key); continue }
        const fd = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const current = fstatSync(fd); bytes += current.size
          if (!current.isFile() || current.nlink !== 1 || current.uid !== this.options.uid || (current.mode & 0o022) !== 0
            || current.size > 10 * 1024 * 1024 || bytes > 100 * 1024 * 1024) throw Error('unsafe_skill_file')
          hash.update(JSON.stringify([key, current.mode & 0o777, current.size]))
          hash.update(readFileSync(fd))
        } finally { closeSync(fd) }
      }
    }
    visit(root, '')
    return hash.digest('hex')
  }
  private entries(profileId: string): Array<{ name: string; digest: string; model_invocable: boolean; user_invocable: boolean }> {
    const root = join(this.root(profileId), 'skills')
    try { this.directory(root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const names = readdirSync(root).sort()
    if (names.length > 128) throw new Error('skill_limit')
    return names.map((name) => {
      const path = join(root, name); const stat = lstatSync(path)
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('unsafe_skill_entry')
      if (stat.isDirectory()) this.directory(path)
      const file = stat.isDirectory() ? join(path, 'SKILL.md') : path
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const fileStat = fstatSync(fd)
        if (!fileStat.isFile() || fileStat.nlink !== 1 || fileStat.uid !== this.options.uid || (fileStat.mode & 0o022) !== 0 || fileStat.size > 32768) throw new Error('unsafe_skill_file')
        const content = readFileSync(fd, 'utf8'); const meta = parseSkillFile(content).meta
        return { name, digest: stat.isDirectory() ? this.treeDigest(path) : createHash('sha256').update(content).digest('hex'),
          model_invocable: meta['disable-model-invocation'] !== true, user_invocable: meta['user-invocable'] !== false }
      } finally { closeSync(fd) }
    })
  }
  private existing(profileId: string, id: string): { path: string; name: string; content: string } {
    const entry = this.entries(profileId).find(row => (row.name.endsWith('.md') ? `flat-${row.name.slice(0, -3)}` : `bundle-${row.name}`) === id)
    if (!entry) throw Error('skill_missing')
    const name = entry.name.replace(/\.md$/u, '')
    const path = join(this.root(profileId), 'skills', entry.name, ...(entry.name.endsWith('.md') ? [] : ['SKILL.md']))
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let content: string
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.options.uid || (stat.mode & 0o022) !== 0 || stat.size > 32768) {
        throw Error('unsafe_skill_file')
      }
      content = readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
    if (parseSkillFile(content).meta.name !== name) throw Error('skill_name_mismatch')
    return { path, name, content }
  }
  private removalLocation(profileId: string, original: ExtensionReceipt): { target: string; backup: string; restored: boolean } {
    if (original.profileId !== profileId || !original.skillRemoval) throw Error('invalid_recovery')
    const evidence = original.skillRemoval
    const bundled = evidence.entryId.startsWith('bundle-'); const name = evidence.entryId.replace(/^(bundle|flat)-/u, '')
    const root = this.root(profileId); this.directory(join(root, 'skills'))
    const target = join(root, 'skills', bundled ? name : `${name}.md`)
    const backup = join(root, `.skill-removed-${original.operationId}`)
    const present = (path: string): boolean => {
      try { lstatSync(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    }
    const restored = present(target); const held = present(backup)
    if (restored === held) throw Error('recovery_conflict')
    if (this.removalDigest(restored ? target : backup, bundled) !== evidence.originalDigest) throw Error('recovery_conflict')
    return { target, backup, restored }
  }
  private removalDigest(path: string, bundled: boolean): string {
    if (bundled) return this.treeDigest(path)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.uid !== this.options.uid || stat.nlink !== 1 || (stat.mode & 0o022) || stat.size > 32768) throw Error('unsafe_skill_file')
      return createHash('sha256').update(readFileSync(fd)).digest('hex')
    } finally { closeSync(fd) }
  }
  /**
   * @param profileId Authorized Profile.
   * @param original Original removal receipt.
   * @returns Validated recovery candidate without mutation.
   */
  async validateSkillRestore(profileId: string, original: ExtensionReceipt): Promise<void> {
    const evidence = original.skillRemoval
    if (!evidence) throw Error('invalid_recovery')
    const location = this.removalLocation(profileId, original)
    const expected = location.restored ? evidence.beforeRevision : evidence.removedRevision
    if (await this.revision(profileId) !== expected) throw Error('recovery_conflict')
  }
  /**
   * @param profileId Authorized Profile.
   * @param original Original removal receipt with Host-private evidence.
   * @param context Confirmed recovery operation lifetime.
   * @returns Success only after the original bytes and default-preset definition are verified.
   */
  async restoreSkillRemoval(profileId: string, original: ExtensionReceipt,
    context: Parameters<ExtensionExecutor['execute']>[2]): ReturnType<ExtensionExecutor['execute']> {
    const evidence = original.skillRemoval
    if (!evidence) throw Error('invalid_recovery')
    const guard = (): void => { context.signal.throwIfAborted(); context.guard() }
    guard(); await this.validateSkillRestore(profileId, original); guard()
    const location = this.removalLocation(profileId, original)
    if (!location.restored) {
      renameSync(location.backup, location.target)
      for (const path of [this.root(profileId), join(this.root(profileId), 'skills')]) {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try { fsyncSync(fd) } finally { closeSync(fd) }
      }
    }
    const entry = this.existing(profileId, evidence.entryId)
    if (await this.revision(profileId) !== evidence.beforeRevision) throw Error('recovery_conflict')
    const observed = await this.options.acknowledge(profileId, entry.name, entry.content, context.signal, guard)
    guard(); verifySkillRuntime(entry.path, entry.content, observed)
    await this.validateSkillRestore(profileId, original); guard()
    return { state: 'succeeded' }
  }
  private async remove(profileId: string, change: RemovalInput,
    context: Parameters<ExtensionExecutor['execute']>[2]): Promise<{ state: 'succeeded' | 'failed'; skillSource?: SkillRemovalSource }> {
    const guard = () => { context.signal.throwIfAborted(); context.guard() }
    guard()
    const original = this.existing(profileId, change.id)
    const bundled = change.id.startsWith('bundle-')
    const target = bundled ? dirname(original.path) : original.path
    const root = this.root(profileId); const skills = join(root, 'skills')
    const operationId = context.operationId ?? randomUUID()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw Error('invalid_input')
    const backup = join(root, `.skill-removed-${operationId}`)
    const backupAbsent = (): void => {
      try { lstatSync(backup); throw Error('skill_backup_exists') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    backupAbsent()
    const digest = (path: string): string => bundled ? this.treeDigest(path) : (() => {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.uid !== this.options.uid || stat.nlink !== 1 || (stat.mode & 0o022) || stat.size > 32768) {
          throw Error('unsafe_skill_file')
        }
        return createHash('sha256').update(readFileSync(fd)).digest('hex')
      } finally { closeSync(fd) }
    })()
    const fingerprint = digest(target)
    const sync = (): void => {
      for (const path of [skills, root]) {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try { fsyncSync(fd) } finally { closeSync(fd) }
      }
    }
    guard()
    if (digest(target) !== fingerprint || this.existing(profileId, change.id).content !== original.content) throw Error('skill_changed')
    const entries = this.entries(profileId)
    const removedName = bundled ? original.name : `${original.name}.md`
    const evidence: SkillRemovalRecovery = { entryId: change.id, originalDigest: fingerprint,
      beforeRevision: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
      removedRevision: createHash('sha256').update(JSON.stringify(entries.filter(entry => entry.name !== removedName))).digest('hex'),
      stage: 'prepared' }
    const checkpoint = (stage: SkillRemovalRecovery['stage']): void => {
      guard(); evidence.stage = stage; context.checkpointSkillRemoval?.({ ...evidence })
    }
    checkpoint('prepared')
    if (digest(target) !== fingerprint) throw Error('skill_changed')
    backupAbsent()
    renameSync(target, backup); sync()
    const revision = await this.revision(profileId)
    if (revision !== evidence.removedRevision) throw Error('skill_changed')
    checkpoint('removed')
    const unchanged = async (): Promise<void> => {
      guard()
      if (await this.revision(profileId) !== revision || digest(backup) !== fingerprint) throw Error('skill_changed')
      try { lstatSync(target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      throw Error('skill_changed')
    }
    let source: SkillRemovalSource
    try {
      const observed = await this.options.acknowledge(profileId, original.name, '', context.signal, guard)
      guard()
      if (observed === null) source = 'absent'
      else {
        if (!observed || typeof observed !== 'object' || Array.isArray(observed)) throw Error('skill_runtime_mismatch')
        const value = observed as Record<string, unknown>
        if (value.name !== original.name || typeof value.source !== 'string' || !value.source
          || typeof value.description !== 'string' || typeof value.content !== 'string'
          || value.path === original.path || typeof value.path === 'string' && value.path.startsWith(`${target}/`)
          || value.source === 'user-dsh' && typeof value.path !== 'string') throw Error('skill_runtime_mismatch')
        const invocation = value.invocation as Record<string, unknown> | undefined
        if (!invocation || typeof invocation.modelInvocable !== 'boolean' || typeof invocation.userInvocable !== 'boolean') {
          throw Error('skill_runtime_mismatch')
        }
        source = ['user-dsh', 'user-agents', 'custom', 'bundled', 'runtime'].includes(value.source)
          ? value.source as SkillRemovalSource : 'other'
      }
    } catch {
      await unchanged()
      renameSync(backup, target); sync()
      const restored = await this.revision(profileId)
      checkpoint('restored')
      const observed = await this.options.acknowledge(profileId, original.name, original.content, context.signal, guard)
      guard(); verifySkillRuntime(original.path, original.content, observed)
      if (await this.revision(profileId) !== restored) throw Error('skill_changed')
      checkpoint('restoration_verified')
      return { state: 'failed' }
    }
    await unchanged()
    checkpoint('removal_verified')
    rmSync(backup, { recursive: bundled }); sync()
    return { state: 'succeeded', skillSource: source }
  }
  private async edit(profileId: string, change: InvocationInput | ReplacementInput,
    context: Parameters<ExtensionExecutor['execute']>[2]): Promise<{ state: 'succeeded' | 'failed' }> {
    const guard = () => { context.signal.throwIfAborted(); context.guard() }
    guard()
    const original = this.existing(profileId, change.id)
    const content = change.action === 'replace' ? change.markdown : setInvocation(original.path, original.content, change.kind, change.value)
    if (Buffer.byteLength(content) > 32768) throw Error('invalid_input')
    const publish = async (next: string, expected: string, expectedRevision: string): Promise<string> => {
      guard()
      const temporary = join(this.root(profileId), `.skill-edit-${randomUUID()}`)
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      let published = false
      try {
        try { writeFileSync(fd, next); fsyncSync(fd) } finally { closeSync(fd) }
        if (await this.revision(profileId) !== expectedRevision) throw Error('skill_changed')
        guard()
        if (this.existing(profileId, change.id).content !== expected) throw Error('skill_changed')
        renameSync(temporary, original.path); published = true
        for (const directory of [dirname(original.path), this.root(profileId)]) {
          const dir = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
          try { fsyncSync(dir) } finally { closeSync(dir) }
        }
      } finally { if (!published) unlinkSync(temporary) }
      return this.revision(profileId)
    }
    const acknowledge = async (markdown: string): Promise<void> => {
      const observed = await this.options.acknowledge(profileId, original.name, markdown, context.signal, guard)
      guard(); verifySkillRuntime(original.path, markdown, observed)
    }
    const revision = await publish(content, original.content, await this.revision(profileId))
    try { await acknowledge(content) } catch {
      const restored = await publish(original.content, content, revision)
      await acknowledge(original.content)
      if (await this.revision(profileId) !== restored) throw Error('skill_changed')
      return { state: 'failed' }
    }
    if (await this.revision(profileId) !== revision) throw Error('skill_changed')
    return { state: 'succeeded' }
  }
  /**
   * @param profileId Authorized Profile.
   * @param kind Market kind.
   * @param payload Strict new-skill fields or a local Markdown or invocation change.
   */
  validate(profileId: string, kind: ExtensionKind, payload: string): void {
    if (kind !== 'skill') throw new Error('upgrade_required')
    const skill = input(payload)
    if ('action' in skill) { this.existing(profileId, skill.id); return }
    if (this.entries(profileId).some(entry => entry.name === skill.name || entry.name === `${skill.name}.md`)) throw new Error('skill_exists')
    if (!('archive' in skill) && !('markdown' in skill) && Buffer.byteLength(renderSkillFile(skill)) > 32768) throw new Error('invalid_input')
  }
  /** @param profileId Authorized Profile. @returns Digest of installed skill names and Markdown bytes. */
  revision(profileId: string): Promise<string> {
    return Promise.resolve().then(() => createHash('sha256').update(JSON.stringify(this.entries(profileId))).digest('hex'))
  }
  /**
   * @param profileId Authorized Profile.
   * @param signal Read lifetime.
   * @returns Local definitions and default-preset winners when available.
   */
  async inventory(profileId: string, signal: AbortSignal = new AbortController().signal): Promise<SkillInventoryEntry[]> {
    signal.throwIfAborted()
    const before = await this.revision(profileId)
    const local = this.entries(profileId).map((entry) => {
      const name = entry.name.replace(/\.md$/u, '')
      if (!skillName.test(name) || name.length > 64) throw new Error('unsafe_skill_entry')
      const flat = entry.name.endsWith('.md')
      return { id: flat ? `flat-${name}` : `bundle-${name}`, name, transport: 'markdown',
        model_invocable: entry.model_invocable, user_invocable: entry.user_invocable,
        path: flat ? join(this.root(profileId), 'skills', entry.name) : join(this.root(profileId), 'skills', entry.name, 'SKILL.md') }
    })
    if (!this.options.catalog) return local.map(({ path: _path, ...entry }) => entry)
    const catalog = await this.options.catalog(profileId, signal)
    signal.throwIfAborted()
    if (before !== await this.revision(profileId)) throw Error('revision_conflict')
    return skillInventory(local, catalog)
  }
  /**
   * @param profileId Authorized Profile.
   * @param payload Confirmed new-skill fields or local Markdown/invocation change.
   * @param context Live operation authority.
   * @returns Success after acknowledgement; ambiguous publication errors propagate to unknown receipts.
   */
  async execute(profileId: string, payload: string, context: Parameters<ExtensionExecutor['execute']>[2]): Promise<{
    state: 'succeeded' | 'failed'
    skillSource?: SkillRemovalSource
  }> {
    const guard = () => { context.signal.throwIfAborted(); context.guard() }
    guard(); this.validate(profileId, context.kind, payload)
    const skill = input(payload)
    if ('action' in skill) return skill.action === 'remove' ? this.remove(profileId, skill, context) : this.edit(profileId, skill, context)
    let files: SkillArchiveFile[]
    let content: string
    if ('archive' in skill) {
      const bundle = inspectSkillArchive(await downloadSkillArchive(skill.archive, context.signal), skill.archive.subPath, skill.name)
      guard(); files = bundle.files; content = bundle.markdown
    } else {
      content = 'markdown' in skill ? skill.markdown : renderSkillFile(skill)
      files = [{ path: 'SKILL.md', data: Buffer.from(content), executable: false }]
    }
    const profileRoot = this.root(profileId); const root = join(profileRoot, 'skills')
    guard()
    try { mkdirSync(root, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    this.directory(root)
    const target = join(root, skill.name)
    // Exclusive creation prevents replacing either a directory or a symbolic link.
    mkdirSync(target, { mode: 0o700 })
    const owned = lstatSync(target)
    const temporary = join(target, `.install-${randomUUID()}`)
    try {
      for (const file of files.filter(file => file.path !== 'SKILL.md')) {
        guard(); this.directory(root); this.directory(target)
        if (lstatSync(target).ino !== owned.ino) throw Error('skill_changed')
        const destination = join(target, file.path)
        const parts = file.path.split('/').slice(0, -1)
        let parent = target
        for (const part of parts) {
          parent = join(parent, part)
          try { mkdirSync(parent, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
          this.directory(parent)
        }
        const resourceFd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          file.executable ? 0o700 : 0o600)
        try { writeFileSync(resourceFd, file.data); fsyncSync(resourceFd) } finally { closeSync(resourceFd) }
      }
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
      guard(); this.directory(root); this.directory(target)
      if (lstatSync(target).ino !== owned.ino || existsSync(join(target, 'SKILL.md'))) throw new Error('skill_changed')
      linkSync(temporary, join(target, 'SKILL.md'))
      unlinkSync(temporary)
      for (const path of [...new Set(files.flatMap((file) => {
        const paths: string[] = []; let parent = dirname(join(target, file.path))
        while (parent !== target) { paths.push(parent); parent = dirname(parent) }
        return paths
      })), target, root, profileRoot]) {
        const directoryFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      }
    } finally {
      try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    guard()
    const observation = await this.options.acknowledge(profileId, skill.name, content, context.signal, guard)
    guard()
    verifySkillRuntime(join(target, 'SKILL.md'), content, observation)
    for (const file of files) {
      const fd = openSync(join(target, file.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.options.uid || (stat.mode & 0o022) !== 0 || stat.size !== file.data.length || !readFileSync(fd).equals(file.data)) throw Error('skill_changed')
      } finally { closeSync(fd) }
    }
    return { state: 'succeeded' }
  }
}
