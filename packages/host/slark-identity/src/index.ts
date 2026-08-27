/**
 * Slark Runtime Cell identity adapter. It scopes Device authority to the
 * calling DSH session and reads the current Edge-issued Grant fences from a
 * private, atomically replaced file for every operation.
 * @module @deepseek-ai/dsh-slark-identity
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  SlarkDeviceClientError,
  type SlarkDeviceAuthority,
} from '@deepseek-ai/dsh-slark-device-client'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const AUTHORITY_KIND = 'slark-dsh-runtime-authority-v1'
const AUTHORITY_FIELDS = [
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
  'grant_id',
  'grant_epoch',
  'expires_at',
] as const

type Row = Record<string, unknown>

/** Runtime Cell identity configuration. */
export interface Config {
  /** Absolute path to the Edge-owned, read-only authority JSON file. */
  authorityFile: string
  /** Workspace handle fixed into the Runtime Cell provider composition. */
  expectedWorkspaceHandle: string
  /** Maximum bytes accepted from the authority file. */
  maxAuthorityBytes?: number
}

type ResolvedConfig = Required<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    slarkIdentity: SlarkIdentity
  }
}

function row(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SlarkDeviceClientError('identity_invalid', 'Slark Runtime Cell authority must be an object')
  }
  return value as Row
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function exactFields(value: Row): void {
  const keys = Object.keys(value)
  if (keys.length !== AUTHORITY_FIELDS.length || keys.some(key => !AUTHORITY_FIELDS.includes(key as typeof AUTHORITY_FIELDS[number]))) {
    throw new SlarkDeviceClientError('identity_invalid', 'Slark Runtime Cell authority fields are invalid')
  }
}

/** Edge-injected identity and operation-scoped session carrier. */
export class SlarkIdentity extends Service {
  static inject = ['slarkDevice']
  static Config: z<Config> = z.object({
    authorityFile: z.string().required(),
    expectedWorkspaceHandle: z.string().required(),
    maxAuthorityBytes: z.number().default(65_536),
  })

  private readonly config: ResolvedConfig
  private readonly sessions = new AsyncLocalStorage<string>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'slarkIdentity')
    this.config = config as ResolvedConfig
    if (!isAbsolute(config.authorityFile)) {
      throw new Error('dsh-slark-identity: authorityFile must be absolute')
    }
    if (!IDENTIFIER.test(config.expectedWorkspaceHandle)) {
      throw new Error('dsh-slark-identity: expectedWorkspaceHandle is invalid')
    }
    if (
      !Number.isSafeInteger(this.config.maxAuthorityBytes)
      || this.config.maxAuthorityBytes < 1
      || this.config.maxAuthorityBytes > 262_144
    ) {
      throw new Error('dsh-slark-identity: maxAuthorityBytes must be an integer from 1 through 262144')
    }

    ctx.effect(() => ctx.slarkDevice.bindAuthority(() => this.currentAuthority()), 'Slark Device authority source')
    ctx.on('tools/execute', (execution, next) => {
      const agent = execution.agent
      return agent === undefined ? next() : this.runForAgent(agent, next)
    })
    ctx.on('agent/pre-step', (payload, next) => this.runForAgent(payload.agent, next))
  }

  /**
   * Run trusted provider work under one DSH session identity.
   * @param sessionId - DSH Session id written into Device Task authority.
   * @param operation - Work whose asynchronous descendants inherit this session.
   * @returns the operation result without altering its sync or async type.
   */
  runForSession<T>(sessionId: string, operation: () => T): T {
    if (!IDENTIFIER.test(sessionId)) {
      throw new SlarkDeviceClientError('identity_invalid', 'DSH session identity is invalid')
    }
    return this.sessions.run(sessionId, operation)
  }

  /**
   * Read and validate the current Edge authority for one explicit DSH session.
   * @param sessionId - DSH Session id paired with the Edge-issued subject.
   * @returns a fresh Device authority snapshot.
   */
  async authorityForSession(sessionId: string): Promise<SlarkDeviceAuthority> {
    if (!IDENTIFIER.test(sessionId)) {
      throw new SlarkDeviceClientError('identity_invalid', 'DSH session identity is invalid')
    }
    let document: Row
    try {
      document = await this.readAuthorityFile()
    } catch (error: unknown) {
      if (error instanceof SlarkDeviceClientError) throw error
      throw new SlarkDeviceClientError('identity_unavailable', 'Slark Runtime Cell authority is unavailable', { cause: error })
    }
    exactFields(document)
    const expiresAt = typeof document.expires_at === 'string' ? Date.parse(document.expires_at) : Number.NaN
    if (
      document.protocol_version !== 1
      || document.kind !== AUTHORITY_KIND
      || !identifier(document.environment_id)
      || typeof document.assignment_id !== 'string'
      || !UUID.test(document.assignment_id)
      || !positiveInteger(document.generation)
      || !identifier(document.owner_user_id)
      || !identifier(document.personal_project_id)
      || typeof document.subject_token !== 'string'
      || document.subject_token.length < 1
      || document.subject_token.length > 16 * 1024
      || !identifier(document.computer_id)
      || !identifier(document.workspace_handle)
      || typeof document.grant_id !== 'string'
      || !UUID.test(document.grant_id)
      || !positiveInteger(document.grant_epoch)
      || !Number.isFinite(expiresAt)
    ) {
      throw new SlarkDeviceClientError('identity_invalid', 'Slark Runtime Cell authority is invalid')
    }
    if (expiresAt <= Date.now()) {
      throw new SlarkDeviceClientError('identity_expired', 'Slark Runtime Cell authority expired')
    }
    if (document.workspace_handle !== this.config.expectedWorkspaceHandle) {
      throw new SlarkDeviceClientError('workspace_changed', 'Slark Runtime Cell workspace authority changed')
    }
    return {
      subjectToken: document.subject_token,
      sessionId,
      computerId: document.computer_id,
      workspaceHandle: document.workspace_handle,
      grantId: document.grant_id,
      grantEpoch: document.grant_epoch,
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

  private async readAuthorityFile(): Promise<Row> {
    const handle = await open(this.config.authorityFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size < 1 || info.size > this.config.maxAuthorityBytes || (info.mode & 0o077) !== 0) {
        throw new SlarkDeviceClientError('identity_unavailable', 'Slark Runtime Cell authority file is not private and bounded')
      }
      const text = await handle.readFile({ encoding: 'utf8' })
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch (error: unknown) {
        throw new SlarkDeviceClientError('identity_invalid', 'Slark Runtime Cell authority is not valid JSON', { cause: error })
      }
      return row(value)
    } finally {
      await handle.close()
    }
  }
}

export default SlarkIdentity
