/**
 * Cordis worker bridge for fenced Slark-to-DSH Agent invocations.
 *
 * The plugin obtains short-lived owner authority from `slarkIdentity`, claims
 * only invocations addressed to one configured formal Agent, runs them in a
 * deterministic project session, and settles the fenced receipt and Thread.
 * @module @deepseek-ai/dsh-slark-collaboration-network
 */
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-slark-identity'
import z from '@deepseek-ai/schemastery'

export const name = 'slark-collaboration-network'
export const inject = ['agents', 'agentPresets', 'slarkIdentity']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const TERMINAL = '/receipts'

export interface FormalAgentConfig {
  formalAgentId: string
  presetRef: string
  authoritySessionId?: string
}

export interface Config {
  enabled: boolean
  gatewayUrl: string
  allowInsecureHttp?: boolean
  serviceToken?: string
  workspaceRoot: string
  workspaceHandle: string
  workerId: string
  formalAgents: FormalAgentConfig[]
  pollIntervalMs?: number
  leaseMs?: number
  requestTimeoutMs?: number
}

type ResolvedConfig = Omit<Required<Config>, 'serviceToken'> & {
  serviceToken: string | undefined
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  gatewayUrl: z.string().required(),
  allowInsecureHttp: z.boolean().default(false),
  serviceToken: z.string(),
  workspaceRoot: z.string().required(),
  workspaceHandle: z.string().required(),
  workerId: z.string().required(),
  formalAgents: z.array(z.object({
    formalAgentId: z.string().required(),
    presetRef: z.string().required(),
    authoritySessionId: z.string(),
  })).default([]),
  pollIntervalMs: z.number().default(1_000),
  leaseMs: z.number().default(120_000),
  requestTimeoutMs: z.number().default(10_000),
})

type Row = Record<string, unknown>

export interface InvocationEnvelope {
  schema_version: 'dsh-slark-agent-invocation/v1'
  target_principal: { kind: 'dsh_agent'; id: string }
  project_id: string
  connection_id: string
  policy_epoch: number
  input_text: string
  payload_digest: string
  channel_id: string
  thread_id: string | null
  source_event_id: string
}

export interface InvocationLease {
  invocationId: string
  projectId: string
  attemptId: string
  attemptFence: number
  leaseToken: string
  envelope: InvocationEnvelope
}

export interface OutboundInvocationResult {
  invocationId: string
  state: string
  attemptFence: number
  duplicate: boolean
}

function row(value: unknown, label: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Row
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function parseEnvelope(value: unknown, formalAgentId: string): InvocationEnvelope {
  const envelope = row(value, 'invocation envelope')
  const target = row(envelope.target_principal, 'target principal')
  if (
    envelope.schema_version !== 'dsh-slark-agent-invocation/v1'
    || target.kind !== 'dsh_agent'
    || target.id !== formalAgentId
    || !IDENTIFIER.test(String(envelope.project_id))
    || !IDENTIFIER.test(String(envelope.connection_id))
    || !positive(envelope.policy_epoch)
    || typeof envelope.input_text !== 'string'
    || envelope.input_text.trim().length === 0
    || Buffer.byteLength(envelope.input_text, 'utf8') > 64 * 1024
    || !DIGEST.test(String(envelope.payload_digest))
    || createHash('sha256').update(envelope.input_text, 'utf8').digest('hex') !== envelope.payload_digest
    || !IDENTIFIER.test(String(envelope.channel_id))
    || !(envelope.thread_id === null
      || (typeof envelope.thread_id === 'string' && IDENTIFIER.test(envelope.thread_id)))
    || !IDENTIFIER.test(String(envelope.source_event_id))
  ) throw new Error('invocation envelope is invalid')
  return envelope as unknown as InvocationEnvelope
}

export class SlarkCollaborationTransport {
  private readonly origin: string
  private readonly serviceToken: string
  private readonly timeoutMs: number

  constructor(config: {
    gatewayUrl: string
    allowInsecureHttp?: boolean
    serviceToken?: string | undefined
    requestTimeoutMs?: number
  }) {
    const url = new URL(config.gatewayUrl)
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password
      || (url.protocol !== 'https:' && !(config.allowInsecureHttp && url.protocol === 'http:'))) {
      throw new Error('slark-collaboration: gatewayUrl must be an exact allowed origin')
    }
    this.origin = url.origin
    this.serviceToken = config.serviceToken ?? process.env.SLARK_DSH_SERVICE_TOKEN ?? ''
    if (this.serviceToken.length < 32) throw new Error('slark-collaboration: service token is required')
    this.timeoutMs = config.requestTimeoutMs ?? 10_000
  }

  private async request(path: string, subjectToken: string, body: Row): Promise<Response> {
    const response = await fetch(`${this.origin}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.serviceToken}`,
        'content-type': 'application/json',
        'x-slark-dsh-subject': subjectToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok && response.status !== 204) {
      throw new Error(`Slark collaboration request failed with HTTP ${response.status}`)
    }
    return response
  }

  async claim(input: {
    subjectToken: string
    workerId: string
    formalAgentId: string
    leaseMs: number
  }): Promise<InvocationLease | null> {
    const response = await this.request('/api/internal/v1/dsh/agent-invocations/claim', input.subjectToken, {
      worker_id: input.workerId,
      formal_agent_id: input.formalAgentId,
      lease_ms: input.leaseMs,
    })
    if (response.status === 204) return null
    const payload = row(await response.json(), 'claim response')
    const data = row(payload.data, 'claim data')
    if (payload.success !== true || !IDENTIFIER.test(String(data.invocation_id))
      || !IDENTIFIER.test(String(data.project_id)) || !IDENTIFIER.test(String(data.attempt_id))
      || !positive(data.attempt_fence) || !UUID.test(String(data.lease_token))) {
      throw new Error('Slark collaboration claim response is invalid')
    }
    return {
      invocationId: String(data.invocation_id), projectId: String(data.project_id),
      attemptId: String(data.attempt_id), attemptFence: data.attempt_fence,
      leaseToken: String(data.lease_token),
      envelope: parseEnvelope(data.envelope, input.formalAgentId),
    }
  }

  async submit(subjectToken: string, envelope: Readonly<Row>, actorAssertion?: string): Promise<OutboundInvocationResult> {
    if (actorAssertion !== undefined && (actorAssertion.length < 1
      || Buffer.byteLength(actorAssertion, 'utf8') > 16 * 1024)) {
      throw new Error('Slark collaboration actor assertion is invalid')
    }
    const response = await this.request('/api/internal/v1/dsh/agent-invocations', subjectToken, {
      envelope, ...(actorAssertion === undefined ? {} : { actor_assertion: actorAssertion }),
    })
    const payload = row(await response.json(), 'admission response')
    const data = row(payload.data, 'admission data')
    if (payload.success !== true || !IDENTIFIER.test(String(data.invocation_id))
      || typeof data.state !== 'string' || !IDENTIFIER.test(data.state)
      || !positive(data.attempt_fence) || typeof data.duplicate !== 'boolean') {
      throw new Error('Slark collaboration admission response is invalid')
    }
    return { invocationId: String(data.invocation_id), state: data.state,
      attemptFence: data.attempt_fence, duplicate: data.duplicate }
  }

  async receipt(subjectToken: string, lease: InvocationLease, kind: 'started' | 'progress' | 'terminal',
    outcome?: 'succeeded' | 'failed' | 'indeterminate'): Promise<void> {
    await this.request(`/api/internal/v1/dsh/agent-invocations/${lease.invocationId}${TERMINAL}`,
      subjectToken, {
        project_id: lease.projectId, attempt_id: lease.attemptId,
        attempt_fence: lease.attemptFence, lease_token: lease.leaseToken,
        kind, ...(kind === 'progress' ? { progress: { phase: 'running' } } : {}),
        ...(outcome === undefined ? {} : { outcome }),
      })
  }

  async project(subjectToken: string, lease: InvocationLease, content: string): Promise<void> {
    await this.request(`/api/internal/v1/dsh/agent-invocations/${lease.invocationId}/thread-projections`,
      subjectToken, {
        project_id: lease.projectId,
        channel_id: lease.envelope.channel_id,
        thread_id: lease.envelope.thread_id,
        source_event_id: `result-${lease.invocationId}-${lease.attemptFence}`,
        content,
        expected_cursor: null,
        next_cursor: `${lease.attemptId}:${lease.attemptFence}`,
      })
  }
}

function sessionId(lease: InvocationLease, formalAgentId: string): ReturnType<typeof SessionId> {
  const digest = createHash('sha256').update([
    lease.envelope.project_id, lease.envelope.connection_id,
    lease.envelope.policy_epoch, formalAgentId,
  ].join('|')).digest('hex')
  return SessionId(`slark-${digest.slice(0, 48)}`)
}

function assistantText(events: readonly SessionEvent[], afterSeq: number): string {
  const messages = events.filter(event => event.seq > afterSeq && event.type === 'assistant/message')
  const last = messages.at(-1)
  if (last?.type !== 'assistant/message') throw new Error('DSH Agent produced no assistant result')
  const text = last.data.message.content
    .filter((part): part is Extract<(typeof last.data.message.content)[number], { type: 'text' }> => part.type === 'text')
    .map(part => part.text).join('')
  if (!text.trim()) throw new Error('DSH Agent produced an empty assistant result')
  return text
}

export class DshInvocationExecutor {
  constructor(private readonly ctx: Context, private readonly workspaceRoot: string) {}

  private async resolveAgent(lease: InvocationLease, formal: FormalAgentConfig): Promise<Agent> {
    const id = sessionId(lease, formal.formalAgentId)
    const live = this.ctx.agents.get(id)
    const preset = await this.ctx.agentPresets.resolve(formal.presetRef)
    if (live !== undefined) {
      if (live.session.header.agentPreset !== preset.id) {
        throw new Error(`formal Agent session preset changed from ${String(live.session.header.agentPreset)} to ${preset.id}`)
      }
      return live
    }
    const setup = (agentCtx: Context) => this.ctx.agentPresets.mount(agentCtx, preset.id).then(() => undefined)
    const persistence = this.ctx.get('sessionPersistence')
    const stored = persistence === undefined ? undefined : (await persistence.list()).find(item => item.id === id)
    if (stored !== undefined && stored.agentPreset !== preset.id) {
      throw new Error(`persisted formal Agent session preset changed from ${String(stored.agentPreset)} to ${preset.id}`)
    }
    return stored !== undefined
      ? (await this.ctx.agents.resume({ resumeSessionId: id, setup })).agent
      : (await this.ctx.agents.create({ sessionId: id,
        meta: { cwd: this.workspaceRoot, agentPreset: preset.id }, setup })).agent
  }

  async execute(lease: InvocationLease, formal: FormalAgentConfig): Promise<string> {
    const agent = await this.resolveAgent(lease, formal)
    const before = agent.session.seq
    await this.ctx.agents.withInitiator(agent, async () => {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: lease.envelope.input_text }],
        source: { kind: 'plugin', plugin: name },
      }))
      await agent.whenIdle()
    })
    return assistantText(agent.session.events, before)
  }
}

export class SlarkCollaborationNetwork extends Service {
  static inject = inject
  static Config = Config
  private readonly config: ResolvedConfig
  private readonly abort = new AbortController()
  private readonly pumps: Promise<void>[] = []
  private transport: SlarkCollaborationTransport | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'slarkCollaborationNetwork')
    this.config = {
      enabled: config.enabled,
      gatewayUrl: config.gatewayUrl,
      serviceToken: config.serviceToken,
      workspaceRoot: config.workspaceRoot,
      workspaceHandle: config.workspaceHandle,
      workerId: config.workerId,
      formalAgents: config.formalAgents,
      allowInsecureHttp: config.allowInsecureHttp ?? false,
      pollIntervalMs: config.pollIntervalMs ?? 1_000,
      leaseMs: config.leaseMs ?? 120_000,
      requestTimeoutMs: config.requestTimeoutMs ?? 10_000,
    }
    if (!isAbsolute(config.workspaceRoot) || !IDENTIFIER.test(config.workspaceHandle)
      || !IDENTIFIER.test(config.workerId)
      || !Number.isSafeInteger(this.config.pollIntervalMs) || this.config.pollIntervalMs < 100
      || !Number.isSafeInteger(this.config.leaseMs) || this.config.leaseMs < 1_000
      || this.config.leaseMs > 300_000 || (config.enabled && config.formalAgents.length === 0)
      || new Set(config.formalAgents.map(item => item.formalAgentId)).size !== config.formalAgents.length
      || config.formalAgents.some(item => !UUID.test(item.formalAgentId) || !IDENTIFIER.test(item.presetRef)
        || `${config.workerId}:${item.formalAgentId}`.length > 256
        || (item.authoritySessionId !== undefined && !IDENTIFIER.test(item.authoritySessionId)))) {
      throw new Error('slark-collaboration: worker configuration is invalid')
    }
    ctx.effect(() => async () => {
      this.abort.abort()
      await Promise.allSettled(this.pumps)
    }, 'slark-collaboration worker stop')
  }

  protected [Service.init](): void {
    if (!this.config.enabled) return
    const transport = new SlarkCollaborationTransport(this.config)
    this.transport = transport
    const executor = new DshInvocationExecutor(this.ctx,
      join(this.config.workspaceRoot, this.config.workspaceHandle))
    for (const formal of this.config.formalAgents) {
      this.pumps.push(this.pump(transport, executor, formal))
    }
  }

  async dispatch(formalAgentId: string, envelopeValue: Readonly<Row>): Promise<OutboundInvocationResult> {
    if (!this.config.enabled || this.transport === undefined) {
      throw new Error('Slark collaboration worker is disabled')
    }
    const formal = this.config.formalAgents.find(item => item.formalAgentId === formalAgentId)
    const envelope = row(envelopeValue, 'outbound invocation envelope')
    const source = row(envelope.source_principal, 'outbound source principal')
    if (formal === undefined || envelope.schema_version !== 'dsh-slark-agent-invocation/v1'
      || source.kind !== 'dsh_agent' || source.id !== formalAgentId) {
      throw new Error('outbound invocation source is not a configured formal Agent')
    }
    const authoritySessionId = formal.authoritySessionId ?? `slark-control-${formal.formalAgentId}`
    const authority = await this.ctx.slarkIdentity.authorityForSession(authoritySessionId)
    return this.transport.submit(authority.subjectToken, envelope)
  }

  async dispatchHuman(authoritySessionId: string, envelopeValue: Readonly<Row>,
    actorAssertion: string): Promise<OutboundInvocationResult> {
    if (!IDENTIFIER.test(authoritySessionId)) throw new Error('DSH human session identity is invalid')
    const envelope = row(envelopeValue, 'outbound invocation envelope')
    const source = row(envelope.source_principal, 'outbound source principal')
    if (envelope.schema_version !== 'dsh-slark-agent-invocation/v1' || source.kind !== 'human') {
      throw new Error('outbound human invocation source is invalid')
    }
    if (!this.config.enabled || this.transport === undefined) {
      throw new Error('Slark collaboration worker is disabled')
    }
    const authority = await this.ctx.slarkIdentity.authorityForSession(authoritySessionId)
    return this.transport.submit(authority.subjectToken, envelope, actorAssertion)
  }

  private async pump(transport: SlarkCollaborationTransport, executor: DshInvocationExecutor,
    formal: FormalAgentConfig): Promise<void> {
    const authoritySessionId = formal.authoritySessionId ?? `slark-control-${formal.formalAgentId}`
    while (!this.abort.signal.aborted) {
      try {
        const authority = await this.ctx.slarkIdentity.authorityForSession(authoritySessionId)
        const lease = await transport.claim({ subjectToken: authority.subjectToken,
          workerId: `${this.config.workerId}:${formal.formalAgentId}`, formalAgentId: formal.formalAgentId,
          leaseMs: this.config.leaseMs })
        if (lease !== null) {
          await transport.receipt(authority.subjectToken, lease, 'started')
          let heartbeat = Promise.resolve()
          let heartbeatFailure: unknown
          const heartbeatTimer = setInterval(() => {
            heartbeat = heartbeat.then(() => transport.receipt(
              authority.subjectToken, lease, 'progress',
            )).catch((error: unknown) => { heartbeatFailure = error })
          }, Math.min(10_000, Math.max(1_000, Math.floor(this.config.leaseMs / 3))))
          heartbeatTimer.unref()
          try {
            const content = await executor.execute(lease, formal)
            clearInterval(heartbeatTimer)
            await heartbeat
            if (heartbeatFailure !== undefined) {
              throw heartbeatFailure instanceof Error
                ? heartbeatFailure
                : new Error('Slark collaboration heartbeat failed', { cause: heartbeatFailure })
            }
            await transport.project(authority.subjectToken, lease, content)
            await transport.receipt(authority.subjectToken, lease, 'terminal', 'succeeded')
          } catch (error: unknown) {
            clearInterval(heartbeatTimer)
            this.ctx.logger.warn(`Slark invocation ${lease.invocationId} failed: ${String(error)}`)
            await transport.receipt(authority.subjectToken, lease, 'terminal', 'indeterminate')
          }
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`Slark collaboration poll failed: ${String(error)}`)
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          this.abort.signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, this.config.pollIntervalMs)
        timer.unref()
        this.abort.signal.addEventListener('abort', finish, { once: true })
      })
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { slarkCollaborationNetwork: SlarkCollaborationNetwork }
}

export default SlarkCollaborationNetwork
