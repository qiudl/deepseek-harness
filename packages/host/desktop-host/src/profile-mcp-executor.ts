import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSeq, parseDocument } from 'yaml'
import { convertToRows, deleteMcpRow, extractMcpServers, mergeMcpRows, parseMcpJson, updateMcpRow } from '#hub-mcp'
import type { ExtensionExecutor, ExtensionKind, ExtensionReceipt, McpRecovery } from './extension-operations.ts'

interface ProfileMcpExecutorOptions {
  /** Host resolves this from its registry; never accept a caller-supplied path. */
  profileRoot(profileId: string): string
  uid: number
  /** Resolve only after the installed MCP configuration is observed by the running Profile. */
  reload(profileId: string, signal: AbortSignal, entryIds: readonly string[],
    guard: () => void, removedIds: readonly string[]): Promise<void>
}

/** Reuses Hub conversion and AST merging while keeping file and reload authority inside Host. */
export class ProfileMcpExecutor implements ExtensionExecutor {
  /** @param options Host-owned target resolver and runtime acknowledgement. */
  constructor(private readonly options: ProfileMcpExecutorOptions) {}

  private directory(profileId: string): string {
    const root = this.options.profileRoot(profileId)
    for (const path of [root, join(root, 'profiles'), join(root, 'profiles', 'web')]) {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.uid !== this.options.uid || (stat.mode & 0o022) !== 0) throw new Error('unsafe_profile')
    }
    return join(root, 'profiles', 'web')
  }
  private snapshot(profileId: string): string | null {
    const file = join(this.directory(profileId), 'cordis.patch.yml')
    let fd: number
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.options.uid || (stat.mode & 0o022) !== 0 || stat.size > 1_048_576) {
        throw new Error('unsafe_patch')
      }
      const text = readFileSync(fd, 'utf8')
      const doc = parseDocument(text)
      if (doc.errors.length || (doc.contents !== null && !isSeq(doc.contents))) throw new Error('invalid_patch')
      return text
    } finally { closeSync(fd) }
  }
  private read(profileId: string): string {
    return this.snapshot(profileId) ?? ''
  }
  /**
   * @param profileId Authorized Profile. @param kind Requested market.
   * @param payload MCP JSON or an exact local MCP update/removal; rejects partial imports.
   */
  validate(profileId: string, kind: ExtensionKind, payload: string): void {
    if (kind !== 'mcp') throw new Error('upgrade_required')
    const raw: unknown = JSON.parse(payload)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_input')
    const input = raw as Record<string, unknown>
    if (input.action === 'remove') {
      this.removal(profileId, input)
      return
    }
    const updating = input.action === 'update'
    if (Object.keys(input).length !== (updating ? 3 : 1) || !input.mcpServers || typeof input.mcpServers !== 'object' || Array.isArray(input.mcpServers)) {
      throw new Error('invalid_input')
    }
    for (const value of Object.values(input.mcpServers)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input')
      const server = value as Record<string, unknown>
      const types = typeof server.command === 'string' ? ['stdio'] : ['http', 'streamable-http']
      if ('type' in server && (typeof server.type !== 'string' || !types.includes(server.type.toLowerCase()))) {
        throw new Error('unsupported_transport')
      }
    }
    const { servers } = parseMcpJson(JSON.stringify({ mcpServers: input.mcpServers }))
    if (updating) {
      if (servers.length !== 1 || input.id !== `mcp-${servers[0]?.name}`) throw new Error('invalid_input')
      this.removal(profileId, { action: 'remove', id: input.id })
    }
    if (!servers.length || servers.length > 32 || servers.length !== Object.keys(input.mcpServers).length) throw new Error('invalid_input')
    for (const server of servers) {
      if (server.transport === 'stdio') {
        if (!server.command?.trim() || server.command.includes('\0')) throw new Error('invalid_input')
      } else {
        const url = new URL(server.url ?? '')
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_input')
      }
    }
    const text = this.read(profileId)
    const merged = mergeMcpRows(text, convertToRows(servers))
    if (Buffer.byteLength(merged) > 1_048_576) throw new Error('invalid_input')
  }
  /** @param profileId Authorized Profile. @returns Digest of the exact Profile patch bytes and file presence. */
  revision(profileId: string): Promise<string> {
    return Promise.resolve().then(() => this.digest(this.snapshot(profileId)))
  }
  /** @param profileId Authorized Profile. @returns MCP names and transports, without credentials or paths. */
  inventory(profileId: string): Promise<Array<{ id: string; name: string; transport: string }>> {
    return Promise.resolve().then(() => extractMcpServers(this.read(profileId)).map((row) => {
      const name = row.config.serverName; const transport = row.config.transport
      if (typeof name !== 'string' || typeof transport !== 'string') throw new Error('invalid_patch')
      return { id: row.id, name, transport }
    }))
  }
  /**
   * @param profileId Authorized target.
   * @param payload Confirmed MCP JSON or update/removal request.
   * @param context Operation lifetime; rechecked immediately before publishing bytes.
   * @returns Success only after runtime acknowledgement. Exceptions after publication remain unknown to the operation owner.
   */
  async execute(profileId: string, payload: string, context: Parameters<ExtensionExecutor['execute']>[2]): Promise<{ state: 'succeeded' | 'failed' }> {
    context.guard()
    this.validate(profileId, context.kind, payload)
    const originalSnapshot = this.snapshot(profileId)
    const original = originalSnapshot ?? ''
    const input = JSON.parse(payload) as Record<string, unknown>
    const removedId = input.action === 'remove' ? this.removal(profileId, input) : undefined
    const removedIds = removedId === undefined ? [] : [removedId]
    const rows = removedIds.length ? [] : convertToRows(parseMcpJson(JSON.stringify({ mcpServers: input.mcpServers })).servers)
    // Activation is an installation acknowledgement only when initial tool discovery failures reject the fiber.
    for (const row of rows) row.config.failOnStartupError = true
    const updatedRow = input.action === 'update' ? rows[0] : undefined
    const merged = removedId !== undefined ? deleteMcpRow(original, removedId)
      : updatedRow ? updateMcpRow(original, updatedRow) : mergeMcpRows(original, rows)
    if (Buffer.byteLength(merged) > 1_048_576) throw new Error('invalid_input')
    const originalIds = extractMcpServers(original).map(row => row.id)
    const introducedIds = extractMcpServers(merged).map(row => row.id).filter(id => !originalIds.includes(id))
    const evidence: McpRecovery = { beforeRevision: this.digest(originalSnapshot), afterRevision: this.digest(merged),
      originalPresent: originalSnapshot !== null, introducedIds, stage: 'prepared' }
    if (context.checkpointMcp && context.operationId) {
      this.backup(profileId, context.operationId, originalSnapshot)
      context.checkpointMcp(evidence)
    }
    this.publish(profileId, merged, originalSnapshot, context.guard)
    context.checkpointMcp?.({ ...evidence, stage: 'published' })
    try {
      await this.options.reload(profileId, context.signal, rows.map(row => row.id), context.guard, removedIds)
      context.guard()
      if (this.snapshot(profileId) !== merged) throw Error('revision_conflict')
    } catch {
      // Restore only bytes still owned by this operation. Revocation or a concurrent edit leaves an unknown receipt.
      this.publish(profileId, originalSnapshot, merged, context.guard)
      context.checkpointMcp?.({ ...evidence, stage: 'restored' })
      await this.options.reload(profileId, context.signal, originalIds, context.guard, introducedIds)
      context.guard()
      if (this.snapshot(profileId) !== originalSnapshot) throw Error('revision_conflict')
      context.checkpointMcp?.({ ...evidence, stage: 'restoration_verified' })
      return { state: 'failed' }
    }
    context.checkpointMcp?.({ ...evidence, stage: 'application_verified' })
    return { state: 'succeeded' }
  }
  private digest(snapshot: string | null): string {
    return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
  }
  private backupPath(profileId: string, operationId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw Error('invalid_input')
    return join(this.directory(profileId), `.mcp-before-${operationId}`)
  }
  private backup(profileId: string, operationId: string, snapshot: string | null): void {
    const file = this.backupPath(profileId, operationId)
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, snapshot === null ? '0' : `1${snapshot}`); fsyncSync(fd) } finally { closeSync(fd) }
    this.syncDirectory(this.directory(profileId))
  }
  private readBackup(profileId: string, original: ExtensionReceipt): string | null {
    if (original.profileId !== profileId || original.kind !== 'mcp' || !original.mcpRecovery) throw Error('invalid_recovery')
    const fd = openSync(this.backupPath(profileId, original.operationId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let text: string
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.options.uid || (stat.mode & 0o077) !== 0
        || stat.size < 1 || stat.size > 1_048_577) throw Error('unsafe_backup')
      text = readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
    if (text !== '0' && !text.startsWith('1')) throw Error('invalid_backup')
    const snapshot = text === '0' ? null : text.slice(1)
    if ((snapshot !== null) !== original.mcpRecovery.originalPresent || this.digest(snapshot) !== original.mcpRecovery.beforeRevision) throw Error('invalid_backup')
    return snapshot
  }
  /** @param profileId Authorized Profile. @param original Interrupted MCP receipt. @returns Validation of backup and current revision. */
  validateMcpRestore(profileId: string, original: ExtensionReceipt): Promise<void> {
    return Promise.resolve().then(() => {
      this.readBackup(profileId, original)
      const evidence = original.mcpRecovery
      if (!evidence) throw Error('invalid_recovery')
      const revision = this.digest(this.snapshot(profileId))
      if (revision !== evidence.afterRevision && revision !== evidence.beforeRevision) throw Error('revision_conflict')
    })
  }
  /**
   * @param profileId Authorized Profile.
   * @param original Interrupted MCP receipt with a durable checkpoint.
   * @param context New confirmed recovery lifetime.
   * @returns Success only after original entries and introduced-entry absence are acknowledged.
   */
  async restoreMcpConfig(profileId: string, original: ExtensionReceipt,
    context: Parameters<ExtensionExecutor['execute']>[2]): Promise<{ state: 'succeeded' }> {
    context.guard()
    await this.validateMcpRestore(profileId, original)
    context.guard()
    const snapshot = this.readBackup(profileId, original)
    const current = this.snapshot(profileId)
    const evidence = original.mcpRecovery
    if (!evidence) throw Error('invalid_recovery')
    if (this.digest(current) !== evidence.afterRevision && current !== snapshot) throw Error('revision_conflict')
    if (current !== snapshot) this.publish(profileId, snapshot, current, context.guard)
    await this.options.reload(profileId, context.signal, extractMcpServers(snapshot ?? '').map(row => row.id),
      context.guard, evidence.introducedIds)
    context.guard()
    if (this.snapshot(profileId) !== snapshot) throw Error('revision_conflict')
    this.readBackup(profileId, original)
    return { state: 'succeeded' }
  }
  private removal(profileId: string, input: Record<string, unknown>): string {
    if (Object.keys(input).length !== 2 || input.action !== 'remove' || typeof input.id !== 'string'
      || !/^mcp-[A-Za-z0-9_-]{1,32}$/u.test(input.id)) throw new Error('invalid_input')
    const rows = extractMcpServers(this.read(profileId)).filter(row => row.id === input.id)
    if (rows.length !== 1) throw new Error('invalid_input')
    return input.id
  }
  private publish(profileId: string, content: string | null, expected: string | null, guard: () => void): void {
    guard()
    const directory = this.directory(profileId)
    if (content === null) {
      guard()
      if (this.snapshot(profileId) !== expected) throw new Error('revision_conflict')
      if (expected !== null) unlinkSync(join(directory, 'cordis.patch.yml'))
      this.syncDirectory(directory)
      return
    }
    const temporary = join(directory, `.${randomUUID()}.mcp-tmp`)
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let published = false
    try {
      try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
      guard()
      if (this.snapshot(profileId) !== expected) throw new Error('revision_conflict')
      renameSync(temporary, join(directory, 'cordis.patch.yml'))
      published = true
      this.syncDirectory(directory)
    } finally { if (!published) unlinkSync(temporary) }
  }
  private syncDirectory(directory: string): void {
    const dir = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }

}
