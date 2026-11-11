/** Agent-owned bounded local reads for a paired step; registrations grant neither execution nor wider file policy.
 * Both Source filesystem modes and every standing DSH mode permit reads. No network, shell, MCP or mutation is exposed.
 * Relative paths use the original current Session directory, not a claimed containment root. Retired nonempty Skills are unsupported.
 */
import { FiberState, symbols, type Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsError } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import type { HostTaskTargetStepBody } from '@deepseek-ai/dsh-host-control-protocol'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

type Permissions = HostTaskTargetStepBody['permissions']
type ReadResult = { path: string; content: string }
type DirectoryResult = { path: string; entries: Array<{ name: string; type: 'file' | 'directory' | 'other' }> }
const READ_BYTES = 16384
const RESULT_BYTES = 32768
const DIRECTORY_ENTRIES = 128
/* oxlint-disable typescript/unbound-method -- Immutable method references are compared, never called without their original provider. */
const LOCAL_READ_METHODS = Object.freeze({ resolve: LocalFileSystem.prototype.resolve, stat: LocalFileSystem.prototype.stat,
  readBytes: LocalFileSystem.prototype.readBytes, listDir: LocalFileSystem.prototype.listDir,
  processPath: LocalFileSystem.prototype.processPath })
const RESOLVE_POLICY = SandboxPolicyService.prototype.resolve
const GET_DIRECTORY = WorkingDirectoryService.prototype.get
const GET_AGENT = AgentRegistry.prototype.get
const GET_TOOL = ToolRuntime.prototype.get
/* oxlint-enable typescript/unbound-method */
function unsupported(): never { throw Error('paired_target_files_unsupported') }
function changed(): never { throw Error('paired_target_files_changed') }
function original(value: object | undefined): unknown {
  return value === undefined ? undefined : Reflect.get(value, symbols.original) ?? value
}
function policyValue(policy: ReturnType<SandboxPolicyService['resolve']>): string {
  return JSON.stringify([policy.mode, policy.workspaceRoot, policy.additionalWritableRoots ?? null, policy.sessionId ?? null])
}

/** Captures exact local providers and one live Agent; all reads retain cancellation through actual IO settlement. */
export class PairedTaskTargetFiles {
  /** Exact scoped definitions owned by this producer; an empty Source allowlist registers no capability. */
  readonly definitions: readonly ToolDefinition[]
  readonly #ctx: Context
  readonly #agent: Agent
  readonly #permissions: Permissions
  readonly #current: () => void
  readonly #fs: LocalFileSystem
  readonly #fsPrototype: object
  readonly #policy: SandboxPolicyService
  readonly #directory: WorkingDirectoryService
  readonly #agents: AgentRegistry
  readonly #tools: ToolRuntime
  readonly #session: Agent['session']
  readonly #permissionValue: string
  readonly #policyValue: string
  readonly #cwd: string
  readonly #signal: AbortSignal
  readonly #closed = new AbortController()
  readonly #operations = new Set<Promise<unknown>>()
  readonly #unregister: Array<() => void> = []
  #closing: Promise<void> | undefined

  /**
   * @param ctx - Actual worker context containing the selected local services.
   * @param agent - Original live Agent; registrations belong only to its scope.
   * @param permissions - Same parsed Source permission object retained by the private paired consumer.
   * @param current - Owner's synchronous final execution check; it grants no permission through this class.
   * @param lifetime - Original worker/admission lifetime retained through every IO Promise.
   */
  constructor(ctx: Context, agent: Agent, permissions: Permissions, current: () => void, lifetime: AbortSignal) {
    if (Object.getPrototypeOf(this) !== PairedTaskTargetFiles.prototype) unsupported()
    lifetime.throwIfAborted()
    if (permissions.skills !== null && permissions.skills.length !== 0) unsupported()
    const fs = original(ctx.get('fs')), policy = original(ctx.get('sandboxPolicy')),
      directory = original(ctx.get('workingDirectory')), agents = original(ctx.get('agents')), tools = original(ctx.get('tools'))
    if (!(fs instanceof LocalFileSystem) ||
      (Object.getPrototypeOf(fs) !== LocalFileSystem.prototype && Object.getPrototypeOf(fs) !== SandboxedFileSystem.prototype) ||
      !(policy instanceof SandboxPolicyService) || Object.getPrototypeOf(policy) !== SandboxPolicyService.prototype ||
      !(directory instanceof WorkingDirectoryService) || Object.getPrototypeOf(directory) !== WorkingDirectoryService.prototype ||
      !(agents instanceof AgentRegistry) || Object.getPrototypeOf(agents) !== AgentRegistry.prototype ||
      !(tools instanceof ToolRuntime) || Object.getPrototypeOf(tools) !== ToolRuntime.prototype) unsupported()
    this.#ctx = ctx
    this.#agent = agent
    this.#permissions = permissions
    this.#current = current
    this.#fs = fs
    this.#fsPrototype = Object.getPrototypeOf(fs) === LocalFileSystem.prototype ? LocalFileSystem.prototype : SandboxedFileSystem.prototype
    this.#policy = policy
    this.#directory = directory
    this.#agents = agents
    this.#tools = tools
    this.#session = agent.session
    this.#permissionValue = JSON.stringify(permissions)
    this.#policyValue = policyValue(policy.resolve({ session: this.#session }))
    this.#cwd = directory.get(this.#session)
    this.#signal = AbortSignal.any([lifetime, this.#closed.signal])
    this.#assertGeneration()
    const definitions: ToolDefinition[] = [
      defineTool({ name: 'read', description: 'Read one UTF-8 text file, up to 16384 bytes.',
        parameters: { file_path: { type: 'string', required: true, description: 'Absolute path or path relative to the current directory.' } },
        output: { schema: { type: 'object', additionalProperties: false, properties: {
          path: { type: 'string', required: true }, content: { type: 'string', required: true },
        } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        isConcurrencySafe: () => true,
        execute: (args, exec) => this.#perform('read', args.file_path, exec),
      }),
      defineTool({ name: 'list_directory', description: 'List one directory, up to 128 direct entries.',
        parameters: { path: { type: 'string', required: true, description: 'Absolute directory or path relative to the current directory.' } },
        output: { schema: { type: 'object', additionalProperties: false, properties: {
          path: { type: 'string', required: true }, entries: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              name: { type: 'string', required: true }, type: { type: 'string', required: true, enum: ['file', 'directory', 'other'] },
            },
          } },
        } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        isConcurrencySafe: () => true,
        execute: (args, exec) => this.#perform('list_directory', args.path, exec),
      }),
    ]
    this.definitions = Object.freeze(definitions.filter(d => permissions.toolAllowlist === null
      || permissions.toolAllowlist.includes(d.name))
      .map((d) => { Object.freeze(d.output); return Object.freeze(d) }))
    Object.defineProperty(this, 'definitions', { writable: false, configurable: false })
    try {
      for (const definition of this.definitions) this.#unregister.push(agent.ctx.tools.register(definition))
      this.assertCurrent()
      agent.ctx.effect(() => () => this.close(), 'paired target: local file reads')
    } catch (error) {
      this.#closed.abort(error)
      for (const unregister of this.#unregister.splice(0)) unregister()
      throw error
    }
  }

  #assertGeneration(): void {
    if (this.#ctx.fiber.state !== FiberState.ACTIVE || this.#agent.ctx.fiber.state !== FiberState.ACTIVE ||
      original(this.#ctx.get('fs')) !== this.#fs || original(this.#ctx.get('sandboxPolicy')) !== this.#policy ||
      original(this.#ctx.get('workingDirectory')) !== this.#directory || original(this.#ctx.get('agents')) !== this.#agents ||
      original(this.#ctx.get('tools')) !== this.#tools || this.#agent.session !== this.#session ||
      Object.getPrototypeOf(this.#fs) !== this.#fsPrototype ||
      Object.getPrototypeOf(this.#policy) !== SandboxPolicyService.prototype ||
      Object.getPrototypeOf(this.#directory) !== WorkingDirectoryService.prototype ||
      Object.getPrototypeOf(this.#agents) !== AgentRegistry.prototype ||
      Object.getPrototypeOf(this.#tools) !== ToolRuntime.prototype ||
      this.#agents.get !== GET_AGENT || this.#agents.get(this.#session.id) !== this.#agent ||
      this.#fs.resolve !== LOCAL_READ_METHODS.resolve || this.#fs.stat !== LOCAL_READ_METHODS.stat ||
      this.#fs.readBytes !== LOCAL_READ_METHODS.readBytes || this.#fs.listDir !== LOCAL_READ_METHODS.listDir ||
      this.#fs.processPath !== LOCAL_READ_METHODS.processPath || Object.keys(this.#fs.internals).length !== 0 ||
      this.#policy.resolve !== RESOLVE_POLICY || this.#directory.get !== GET_DIRECTORY ||
      this.#tools.get !== GET_TOOL ||
      JSON.stringify(this.#permissions) !== this.#permissionValue ||
      policyValue(this.#policy.resolve({ session: this.#session })) !== this.#policyValue ||
      this.#directory.get(this.#session) !== this.#cwd) changed()
  }

  /** Refuse execution unless the original owner, permissions and selected file providers remain current.
   * @param expectedAgent - Omission checks this instance's Agent; a supplied value must be that same object.
   * @param expectedPermissions - Omission checks retained permissions; a supplied value must be the original object.
   * @throws after cancellation, owner denial, provider replacement, permission drift or scoped-definition replacement.
   */
  assertCurrent(expectedAgent: Agent = this.#agent, expectedPermissions: Permissions = this.#permissions): void {
    this.#assertExecution(expectedAgent, expectedPermissions)
  }

  #assertExecution(expectedAgent: Agent | undefined, expectedPermissions: Permissions): void {
    this.#signal.throwIfAborted()
    if (expectedAgent !== this.#agent || expectedPermissions !== this.#permissions) changed()
    this.#assertGeneration()
    for (const definition of this.definitions)
      if (this.#tools.get(definition.name, this.#agent) !== definition) changed()
    this.#current()
    this.#signal.throwIfAborted()
    this.#assertGeneration()
  }

  /**
   * Read provider-generation facts after normal closure without renewing owner authorization or allowing execution.
   * @returns A private read-only check; false means replaced/unavailable facts, never permission to start a call.
   */
  captureCurrent(): () => boolean {
    this.#assertGeneration()
    return () => {
      try { this.#assertGeneration(); return true }
      catch (error) { void error; return false }
    }
  }

  async #perform(name: 'read', path: string, exec: ToolRunContext): Promise<ReadResult>
  async #perform(name: 'list_directory', path: string, exec: ToolRunContext): Promise<DirectoryResult>
  async #perform(name: 'read' | 'list_directory', path: string, exec: ToolRunContext): Promise<ReadResult | DirectoryResult> {
    if (!path.trim() || path.includes('\0') || Buffer.byteLength(path, 'utf8') > 4096)
      throw new FsError('The path must be non-empty, contain no NUL and fit in 4096 UTF-8 bytes.', 'FS_IO_ERROR')
    this.#assertExecution(exec.agent, this.#permissions)
    if (exec.agent !== this.#agent || exec.name !== name || !this.definitions.some(d => d.name === name)) changed()
    const signal = AbortSignal.any([this.#signal, exec.signal])
    signal.throwIfAborted()
    const operation = (async () => {
      const target = await this.#fs.resolve(path, { cwd: this.#cwd, signal })
      signal.throwIfAborted(); this.#assertExecution(this.#agent, this.#permissions)
      const info = await this.#fs.stat(target, signal)
      signal.throwIfAborted(); this.#assertExecution(this.#agent, this.#permissions)
      if (info === undefined) throw new FsError(`Path not found: ${path}`, 'FS_NOT_FOUND')
      if (info.type !== (name === 'read' ? 'file' : 'directory'))
        throw new FsError(name === 'read' ? 'The path must name a regular file.' : 'The path must name a directory.',
          name === 'read' ? 'FS_NOT_REGULAR_FILE' : 'FS_NOT_DIRECTORY')
      let result: ReadResult | DirectoryResult
      if (name === 'read') {
        const bytes = await this.#fs.readBytes(target, signal, READ_BYTES)
        signal.throwIfAborted(); this.#assertExecution(this.#agent, this.#permissions)
        let content: string
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        catch (error) { throw new FsError('The file must contain valid UTF-8 text.', 'FS_NOT_TEXT', { cause: error }) }
        if (content.includes('\0')) throw new FsError('The file must contain text without NUL bytes.', 'FS_NOT_TEXT')
        result = { path: this.#fs.processPath(target), content }
      } else {
        const entries = await this.#fs.listDir(target, signal)
        signal.throwIfAborted(); this.#assertExecution(this.#agent, this.#permissions)
        if (entries.length > DIRECTORY_ENTRIES) throw new FsError('The directory exceeds 128 entries; choose a smaller directory.', 'FS_TOO_LARGE')
        result = { path: this.#fs.processPath(target), entries: entries.map(e => ({ name: e.name, type: e.type }))
          .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > RESULT_BYTES)
        throw new FsError('The complete result exceeds 32768 UTF-8 bytes; choose a smaller input.', 'FS_TOO_LARGE')
      signal.throwIfAborted(); this.#assertExecution(this.#agent, this.#permissions)
      return result
    })()
    this.#operations.add(operation)
    try { return await operation } finally { this.#operations.delete(operation) }
  }

  /** Seal new calls immediately, abort reads and remove only this owner's registrations after actual IO settles.
   * @returns Completion after all original IO Promises have settled; repeated closure shares that same completion.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    const completion = Promise.withResolvers<void>()
    this.#closing = completion.promise
    this.#closed.abort(Error('paired_target_files_closed'))
    const cleanup = (async () => {
      await Promise.allSettled([...this.#operations])
      for (const unregister of this.#unregister.splice(0)) unregister()
    })()
    void cleanup.then(completion.resolve, completion.reject)
    return completion.promise
  }
}
