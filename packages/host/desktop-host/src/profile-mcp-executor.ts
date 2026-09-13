import { createHash } from 'node:crypto'
import { isSeq, parseDocument } from 'yaml'
import { PosixMcpStorage, type ProfileMcpStorage } from './profile-mcp-storage.ts'
import { convertToRows, deleteMcpRow, extractMcpServers, mergeMcpRows, parseMcpJson, updateMcpRow } from '#hub-mcp'
import type { ExtensionExecutor, ExtensionKind, ExtensionReceipt, McpRecovery } from './extension-operations.ts'

type ProfileMcpExecutorOptions = ({ profileRoot(profileId: string): string; uid: number } | { storage: ProfileMcpStorage }) & {
  /** Resolve only after the installed MCP configuration is observed by the running Profile. */
  reload(profileId: string, signal: AbortSignal, entryIds: readonly string[],
    guard: () => void, removedIds: readonly string[]): Promise<void>
}

/** Reuses Hub conversion and AST merging while keeping file and reload authority inside Host. */
export class ProfileMcpExecutor implements ExtensionExecutor {
  /** @param options Host-owned target resolver and runtime acknowledgement. */
  constructor(private readonly options: ProfileMcpExecutorOptions) {
    this.storage = 'storage' in options ? options.storage : new PosixMcpStorage(options)
  }
  private readonly storage: ProfileMcpStorage

  private snapshot(profileId: string): string | null {
    const text = this.storage.snapshot(profileId)
    if (text === null) return null
    const doc = parseDocument(text)
    if (doc.errors.length || (doc.contents !== null && !isSeq(doc.contents))) throw new Error('invalid_patch')
    return text
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
      this.storage.backup(profileId, context.operationId, originalSnapshot)
      context.checkpointMcp(evidence)
    }
    this.storage.publish(profileId, merged, originalSnapshot, context.guard)
    context.checkpointMcp?.({ ...evidence, stage: 'published' })
    try {
      await this.options.reload(profileId, context.signal, rows.map(row => row.id), context.guard, removedIds)
      context.guard()
      if (this.snapshot(profileId) !== merged) throw Error('revision_conflict')
    } catch {
      // Restore only bytes still owned by this operation. Revocation or a concurrent edit leaves an unknown receipt.
      this.storage.publish(profileId, originalSnapshot, merged, context.guard)
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
  private readBackup(profileId: string, original: ExtensionReceipt): string | null {
    if (original.profileId !== profileId || original.kind !== 'mcp' || !original.mcpRecovery) throw Error('invalid_recovery')
    const text = this.storage.readBackup(profileId, original.operationId)
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
    if (current !== snapshot) this.storage.publish(profileId, snapshot, current, context.guard)
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

}
