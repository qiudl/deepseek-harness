/**
 * Slark Runtime Cell identity adapter. It scopes Device authority to the
 * calling DSH session and refreshes Edge-owned Grant fences without exposing
 * subject credentials to browser clients.
 * @module @deepseek-ai/dsh-slark-identity
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  SlarkDeviceClientError,
  type SlarkDeviceAuthority,
} from '@deepseek-ai/dsh-slark-device-client'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const AUTHORITY_KIND_V1 = 'slark-dsh-runtime-authority-v1'
const AUTHORITY_KIND_V2 = 'slark-dsh-runtime-authority-v2'
const REFRESH_PATH = '/api/internal/v1/dsh/authority/refresh'
const AUTHORITY_FIELDS_V1 = [
  'protocol_version',
  'kind',
  'environment_id',
  'assignment_id',
  'generation',
  'owner_user_id',
  'personal_project_id',
  'subject_token',
  'computer_id',
  'workspace_handle',
  'workspace_alias',
  'grant_id',
  'grant_epoch',
  'expires_at',
] as const
const AUTHORITY_FIELDS_V2 = [
  ...AUTHORITY_FIELDS_V1,
  'caller_profile',
  'authority_version',
  'consent_profile_version',
  'protected_root_policy_version',
  'safe_file_broker_protocol_version',
  'selection_publication_version',
] as const
const STATE_FIELDS = [
  'assignment_id',
  'generation',
  'publication_version',
  'workspace_handle',
  'workspace_alias',
  'grant_id',
  'grant_epoch',
] as const

type Row = Record<string, unknown>
interface AuthorityDocumentV1 {
  protocol_version: 1
  kind: typeof AUTHORITY_KIND_V1
  environment_id: string
  assignment_id: string
  generation: number
  owner_user_id: string
  personal_project_id: string
  subject_token: string
  computer_id: string
  workspace_handle: string
  workspace_alias: string
  grant_id: string
  grant_epoch: number
  expires_at: string
}
interface AuthorityDocumentV2 extends Omit<AuthorityDocumentV1, 'protocol_version' | 'kind'> {
  protocol_version: 2
  kind: typeof AUTHORITY_KIND_V2
  caller_profile: 'web_dsh_v1'
  authority_version: number
  consent_profile_version: 1
  protected_root_policy_version: 1
  safe_file_broker_protocol_version: 1
  selection_publication_version: number
}
type ParsedAuthority = {
  document: AuthorityDocumentV1 | AuthorityDocumentV2
  expiresAt: number
}
type PublicationFence = { assignmentId: string; generation: number; publicationVersion: number }
type PublicationState = PublicationFence & (
  | { workspaceHandle: null; workspaceAlias: null }
  | { workspaceHandle: string; workspaceAlias: string }
)

/** Runtime Cell identity configuration. */
export interface Config {
  /** Select the Web DSH v2 authority and filesystem-only caller profile. */
  callerProfile?: 'web_dsh_v1'
  /** Absolute directory containing one Edge-owned authority file per DSH Session. */
  authorityDirectory: string
  /** Absolute root containing read-only local projections for Slark workspaces. */
  workspaceRoot: string
  /** Workspace handle fixed into this Runtime Cell process composition. */
  expectedWorkspaceHandle: string
  /** Slark environment authenticated by the Cell refresh request. */
  environmentId: string
  /** Runtime Cell id authenticated by its unique refresh key. */
  cellId: string
  /** Exact loopback Edge authority refresh URL. */
  refreshUrl: string
  /** Cell refresh key; omission reads `SLARK_DSH_CELL_REFRESH_KEY`. */
  refreshKey?: string
  /** Refresh authorities this many milliseconds before expiry. */
  refreshBeforeExpiryMs?: number
  /** Timeout for one Edge refresh request. */
  refreshTimeoutMs?: number
  /** Maximum bytes accepted from one authority file. */
  maxAuthorityBytes?: number
}

type ResolvedConfig = Required<Omit<Config, 'refreshKey' | 'callerProfile'>>
  & Pick<Config, 'callerProfile'>
  & { refreshKey: string }

declare module '@deepseek-ai/cordis' {
  interface Context {
    slarkIdentity: SlarkIdentity
  }
}

function row(value: unknown, message: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SlarkDeviceClientError('identity_invalid', message)
  }
  return value as Row
}

function exactFields(value: Row, fields: readonly string[], message: string): void {
  const keys = Object.keys(value)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
    throw new SlarkDeviceClientError('identity_invalid', message)
  }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function privateFileMode(mode: number): boolean {
  const permissions = mode & 0o777
  return permissions === 0o600 || permissions === 0o640
}

function canonicalTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : Number.NaN
}

function refreshKey(raw: string): Buffer {
  const decoded = Buffer.from(raw, 'base64url')
  if (decoded.length !== 32 || decoded.toString('base64url') !== raw) {
    throw new Error('dsh-slark-identity: refreshKey must be canonical 32-byte base64url')
  }
  return decoded
}

/**
 * Build the authenticated Cell refresh message shared with Slark Edge.
 * @param timestamp - Decimal Unix seconds.
 * @param nonce - Canonical random base64url nonce.
 * @param method - HTTP method.
 * @param url - Exact request path.
 * @param bodyDigest - Lowercase SHA-256 body digest.
 * @param environmentId - Slark environment id.
 * @param cellId - Runtime Cell id.
 * @returns Newline-delimited HMAC input.
 */
export function cellRefreshMessage(
  timestamp: string,
  nonce: string,
  method: string,
  url: string,
  bodyDigest: string,
  environmentId: string,
  cellId: string,
): string {
  return [
    'v1',
    timestamp,
    nonce,
    method.toUpperCase(),
    url,
    bodyDigest,
    environmentId,
    cellId,
  ].join('\n')
}

/** Edge-injected identity, workspace registration, and operation-scoped session carrier. */
export class SlarkIdentity extends Service {
  static inject = ['slarkDevice', 'workspaceRegistry']
  static Config: z<Config> = z.object({
    callerProfile: z.const('web_dsh_v1'),
    authorityDirectory: z.string().required(),
    workspaceRoot: z.string().required(),
    expectedWorkspaceHandle: z.string().required(),
    environmentId: z.string().required(),
    cellId: z.string().required(),
    refreshUrl: z.string().required(),
    refreshKey: z.string(),
    refreshBeforeExpiryMs: z.number().default(60_000),
    refreshTimeoutMs: z.number().default(5_000),
    maxAuthorityBytes: z.number().default(65_536),
  })

  private readonly config: ResolvedConfig
  private readonly key: Buffer
  private readonly sessions = new AsyncLocalStorage<string>()
  private readonly refreshes = new Map<string, Promise<void>>()
  private canonicalWorkspaceRoot = ''

  constructor(ctx: Context, config: Config) {
    super(ctx, 'slarkIdentity')
    const refreshSecret = config.refreshKey ?? process.env.SLARK_DSH_CELL_REFRESH_KEY ?? ''
    this.config = { ...config, refreshKey: refreshSecret } as ResolvedConfig
    if (!isAbsolute(config.authorityDirectory) || !isAbsolute(config.workspaceRoot)) {
      throw new Error('dsh-slark-identity: authorityDirectory and workspaceRoot must be absolute')
    }
    if (
      !IDENTIFIER.test(config.expectedWorkspaceHandle)
      || !IDENTIFIER.test(config.environmentId)
      || !/^[1-8]$/u.test(config.cellId)
    ) {
      throw new Error('dsh-slark-identity: Runtime Cell identity is invalid')
    }
    const refresh = new URL(config.refreshUrl)
    if (
      refresh.protocol !== 'http:'
      || refresh.hostname !== '127.0.0.1'
      || refresh.pathname !== REFRESH_PATH
      || refresh.username
      || refresh.password
      || refresh.search
      || refresh.hash
      || refresh.href !== config.refreshUrl
    ) {
      throw new Error('dsh-slark-identity: refreshUrl must be the exact loopback Edge endpoint')
    }
    this.assertInteger('maxAuthorityBytes', this.config.maxAuthorityBytes, 262_144)
    this.assertInteger('refreshBeforeExpiryMs', this.config.refreshBeforeExpiryMs, 240_000)
    this.assertInteger('refreshTimeoutMs', this.config.refreshTimeoutMs, 30_000)
    this.key = refreshKey(refreshSecret)

    ctx.effect(() => ctx.slarkDevice.bindAuthority(() => this.currentAuthority()), 'Slark Device authority source')
    ctx.on('tools/execute', (execution, next) => {
      const agent = execution.agent
      return agent === undefined ? next() : this.runForAgent(agent, next)
    })
    ctx.on('agent/pre-step', (payload, next) => this.runForAgent(payload.agent, next))
  }

  protected async [Service.init](): Promise<void> {
    await this.validateDirectory(this.config.authorityDirectory, 'authorityDirectory')
    await this.validateDirectory(this.config.workspaceRoot, 'workspaceRoot')
    this.canonicalWorkspaceRoot = await realpath(this.config.workspaceRoot)
    await this.reconcileWorkspace()
  }

  /**
   * Run trusted provider work under one DSH session identity.
   * @param sessionId - DSH Session id written into Device Task authority.
   * @param operation - Work whose asynchronous descendants inherit this session.
   * @returns The operation result without altering its sync or async type.
   */
  runForSession<T>(sessionId: string, operation: () => T): T {
    if (!IDENTIFIER.test(sessionId)) {
      throw new SlarkDeviceClientError('identity_invalid', 'DSH session identity is invalid')
    }
    return this.sessions.run(sessionId, operation)
  }

  /**
   * Read or refresh the Edge authority for one explicit DSH Session.
   * @param sessionId - DSH Session id paired with the Edge-issued subject.
   * @returns A fresh Device authority snapshot.
   */
  async authorityForSession(sessionId: string): Promise<SlarkDeviceAuthority> {
    if (!IDENTIFIER.test(sessionId)) {
      throw new SlarkDeviceClientError('identity_invalid', 'DSH session identity is invalid')
    }
    let authority: ParsedAuthority
    try {
      authority = await this.readAuthority(sessionId)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw this.identityReadError(error)
      await this.refreshAuthority(sessionId)
      authority = await this.readAfterRefresh(sessionId)
    }
    if (authority.expiresAt <= Date.now() + this.config.refreshBeforeExpiryMs) {
      await this.refreshAuthority(sessionId)
      authority = await this.readAfterRefresh(sessionId)
    }
    if (authority.expiresAt <= Date.now()) {
      throw new SlarkDeviceClientError('identity_expired', 'Slark Runtime Cell authority expired')
    }
    const document = authority.document
    if (document.workspace_handle !== this.config.expectedWorkspaceHandle) {
      throw new SlarkDeviceClientError('workspace_changed', 'Slark Runtime Cell workspace authority changed')
    }
    const base = {
      subjectToken: document.subject_token,
      sessionId,
      computerId: document.computer_id,
      workspaceHandle: document.workspace_handle,
      grantId: document.grant_id,
      grantEpoch: document.grant_epoch,
    }
    if (document.protocol_version === 1) return base
    const state = await this.readPublicationState()
    if (
      state === null
      || state.workspaceHandle === null
      || state.assignmentId !== document.assignment_id
      || state.generation !== document.generation
      || state.publicationVersion !== document.selection_publication_version
      || state.workspaceHandle !== document.workspace_handle
    ) {
      throw new SlarkDeviceClientError('identity_invalid', 'Slark Web authority publication fence is stale')
    }
    return {
      ...base,
      callerProfile: 'web_dsh_v1',
      authorityVersion: document.authority_version,
      assignmentId: document.assignment_id,
      assignmentGeneration: document.generation,
      selectionPublicationVersion: document.selection_publication_version,
      consentProfileVersion: 1,
      protectedRootPolicyVersion: 1,
      safeFileBrokerProtocolVersion: 1,
    }
  }

  private assertInteger(name: string, value: number, maximum: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`dsh-slark-identity: ${name} must be an integer from 1 through ${maximum}`)
    }
  }

  private async validateDirectory(path: string, name: string): Promise<void> {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o027) !== 0) {
      throw new Error(`dsh-slark-identity: ${name} must be a private real directory`)
    }
  }

  private runForAgent<T>(agent: Agent, operation: () => T): T {
    return this.runForSession(agent.session.id, operation)
  }

  private async currentAuthority(): Promise<SlarkDeviceAuthority> {
    const sessionId = this.sessions.getStore()
    if (sessionId === undefined) {
      throw new SlarkDeviceClientError('identity_unavailable', 'Slark Device operation has no DSH session identity')
    }
    return this.authorityForSession(sessionId)
  }

  private async readAfterRefresh(sessionId: string): Promise<ParsedAuthority> {
    try {
      return await this.readAuthority(sessionId)
    } catch (error: unknown) {
      throw this.identityReadError(error)
    }
  }

  private identityReadError(error: unknown): SlarkDeviceClientError {
    return error instanceof SlarkDeviceClientError
      ? error
      : new SlarkDeviceClientError(
        'identity_unavailable',
        'Slark Runtime Cell authority is unavailable',
        { cause: error },
      )
  }

  private async readAuthority(sessionId: string): Promise<ParsedAuthority> {
    const handle = await open(
      join(this.config.authorityDirectory, `${sessionId}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const info = await handle.stat()
      if (
        !info.isFile()
        || info.size < 1
        || info.size > this.config.maxAuthorityBytes
        || !privateFileMode(info.mode)
      ) {
        throw new SlarkDeviceClientError(
          'identity_unavailable',
          'Slark Runtime Cell authority file is not private and bounded',
        )
      }
      let value: unknown
      try {
        value = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
      } catch (error: unknown) {
        throw new SlarkDeviceClientError(
          'identity_invalid',
          'Slark Runtime Cell authority is not valid JSON',
          { cause: error },
        )
      }
      return this.parseAuthority(value)
    } finally {
      await handle.close()
    }
  }

  private parseAuthority(value: unknown): ParsedAuthority {
    const document = row(value, 'Slark Runtime Cell authority must be an object')
    const web = this.config.callerProfile === 'web_dsh_v1'
    exactFields(document, web ? AUTHORITY_FIELDS_V2 : AUTHORITY_FIELDS_V1, 'Slark Runtime Cell authority fields are invalid')
    const expiresAt = canonicalTimestamp(document.expires_at)
    if (
      document.protocol_version !== (web ? 2 : 1)
      || document.kind !== (web ? AUTHORITY_KIND_V2 : AUTHORITY_KIND_V1)
      || document.environment_id !== this.config.environmentId
      || !identifier(document.assignment_id)
      || !positiveInteger(document.generation)
      || !identifier(document.owner_user_id)
      || !identifier(document.personal_project_id)
      || typeof document.subject_token !== 'string'
      || document.subject_token.length < 1
      || document.subject_token.length > 16 * 1024
      || !identifier(document.computer_id)
      || !identifier(document.workspace_handle)
      || typeof document.workspace_alias !== 'string'
      || document.workspace_alias.length < 1
      || document.workspace_alias.length > 128
      || typeof document.grant_id !== 'string'
      || !UUID.test(document.grant_id)
      || !positiveInteger(document.grant_epoch)
      || !Number.isSafeInteger(expiresAt)
      || (web && (
        document.caller_profile !== 'web_dsh_v1'
        || !positiveInteger(document.authority_version)
        || document.consent_profile_version !== 1
        || document.protected_root_policy_version !== 1
        || document.safe_file_broker_protocol_version !== 1
        || !positiveInteger(document.selection_publication_version)
      ))
    ) {
      throw new SlarkDeviceClientError('identity_invalid', 'Slark Runtime Cell authority is invalid')
    }
    return {
      document: document as unknown as AuthorityDocumentV1 | AuthorityDocumentV2,
      expiresAt,
    }
  }

  private refreshAuthority(sessionId: string): Promise<void> {
    const current = this.refreshes.get(sessionId)
    if (current !== undefined) return current
    const refresh = this.requestRefresh(sessionId)
    this.refreshes.set(sessionId, refresh)
    void refresh.finally(() => {
      if (this.refreshes.get(sessionId) === refresh) this.refreshes.delete(sessionId)
    }).catch(() => undefined)
    return refresh
  }

  private async requestRefresh(sessionId: string): Promise<void> {
    const value = { cell_id: this.config.cellId, session_id: sessionId }
    const body = JSON.stringify(value)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomBytes(16).toString('base64url')
    const digest = createHash('sha256').update(body).digest('hex')
    const signature = createHmac('sha256', this.key)
      .update(cellRefreshMessage(
        timestamp,
        nonce,
        'POST',
        REFRESH_PATH,
        digest,
        this.config.environmentId,
        this.config.cellId,
      ))
      .digest('base64url')
    let response: Response
    try {
      response = await fetch(this.config.refreshUrl, {
        method: 'POST',
        headers: {
          authorization: `DSH-Cell v1.${timestamp}.${nonce}.${signature}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(this.config.refreshTimeoutMs),
      })
    } catch (error: unknown) {
      throw new SlarkDeviceClientError(
        'identity_unavailable',
        'Slark Runtime Cell authority refresh is unavailable',
        { cause: error },
      )
    }
    const payload = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const failure = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Row).code
        : undefined
      const code = failure === 'grant_selection_required' || failure === 'grant_unavailable'
        ? failure
        : 'identity_unavailable'
      throw new SlarkDeviceClientError(code, `Slark Runtime Cell authority refresh failed with HTTP ${response.status}`)
    }
    const result = row(payload, 'Slark Runtime Cell authority refresh response must be an object')
    exactFields(
      result,
      ['ok', 'workspace_handle', 'workspace_alias', 'expires_at'],
      'Slark Runtime Cell authority refresh response fields are invalid',
    )
    if (
      result.ok !== true
      || !identifier(result.workspace_handle)
      || typeof result.workspace_alias !== 'string'
      || result.workspace_alias.length < 1
      || result.workspace_alias.length > 128
      || !Number.isSafeInteger(canonicalTimestamp(result.expires_at))
    ) {
      throw new SlarkDeviceClientError('identity_invalid', 'Slark Runtime Cell authority refresh response is invalid')
    }
  }

  private async readPublicationState(): Promise<PublicationState | null> {
    let handle
    try {
      handle = await open(
        join(this.config.authorityDirectory, '.publication-state'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size < 1 || info.size > 4_096 || !privateFileMode(info.mode)) {
        throw new Error('dsh-slark-identity: publication state is not private and bounded')
      }
      const value = row(
        JSON.parse(await handle.readFile('utf8')) as unknown,
        'Slark Runtime Cell publication state must be an object',
      )
      exactFields(value, STATE_FIELDS, 'Slark Runtime Cell publication state fields are invalid')
      const empty = value.workspace_handle === null
        && value.workspace_alias === null
        && value.grant_id === null
        && value.grant_epoch === null
      const selected = identifier(value.workspace_handle)
        && typeof value.workspace_alias === 'string'
        && value.workspace_alias.length >= 1
        && value.workspace_alias.length <= 128
        && typeof value.grant_id === 'string'
        && UUID.test(value.grant_id)
        && positiveInteger(value.grant_epoch)
      if (
        !identifier(value.assignment_id)
        || !positiveInteger(value.generation)
        || !positiveInteger(value.publication_version)
        || (!empty && !selected)
      ) {
        throw new Error('dsh-slark-identity: publication state is invalid')
      }
      return empty
        ? {
          assignmentId: value.assignment_id,
          generation: value.generation,
          publicationVersion: value.publication_version,
          workspaceHandle: null,
          workspaceAlias: null,
        }
        : {
          assignmentId: value.assignment_id,
          generation: value.generation,
          publicationVersion: value.publication_version,
          workspaceHandle: value.workspace_handle as string,
          workspaceAlias: value.workspace_alias as string,
        }
    } finally {
      await handle.close()
    }
  }

  private managedWorkspace(path: string): boolean {
    const child = relative(this.canonicalWorkspaceRoot, path)
    return child.length > 0 && !child.startsWith('..') && !isAbsolute(child)
  }

  private async reconcileWorkspace(): Promise<void> {
    const state = await this.readPublicationState()
    const selected = state?.workspaceHandle === null || state === null ? null : state
    if (
      selected !== null
      && selected.workspaceHandle !== this.config.expectedWorkspaceHandle
    ) {
      throw new Error('dsh-slark-identity: provider composition does not match publication state')
    }
    const selectedPath = selected === null
      ? null
      : join(this.canonicalWorkspaceRoot, selected.workspaceHandle)
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (this.managedWorkspace(workspace.path) && workspace.path !== selectedPath) {
        await this.ctx.workspaceRegistry.delete(workspace.id)
      }
    }
    if (selectedPath === null || selected === null) return
    const workspace = await this.ctx.workspaceRegistry.create(selectedPath, selected.workspaceAlias)
    if (workspace.title !== selected.workspaceAlias) {
      await workspace.setTitle(selected.workspaceAlias)
    }
  }
}

export default SlarkIdentity
