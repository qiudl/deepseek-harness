/**
 * Authenticated same-host Slark collaboration context for a DSH Web process.
 * The plugin speaks Slark's newline-delimited ACP bootstrap over an owner-only
 * Unix socket, keeps the formal Web runtime independently usable while Slark
 * is absent, and projects accepted context into model and shell execution.
 * @module @deepseek-ai/dsh-slark-local-collaboration
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-system-prompt'

/** Stable Cordis plugin name. */
export const name = 'slark-local-collaboration'
/** Services receiving and exposing authenticated collaboration context. */
export const inject = ['webServer', 'systemPrompt', 'shellEnv']

const REGISTER = 'slark.dsh-local.register.v1'
const CHALLENGE = 'slark.dsh-local.challenge.v1'
const PROOF = 'slark.dsh-local.proof.v1'
const ACP_INITIALIZE = 'slark.dsh-local.acp.initialize.v1'
const ACP_READY = 'slark.dsh-local.acp.ready.v1'
const ACP_CONTEXT_SET = 'slark.dsh-local.acp.context.set.v2'
const ACP_CONTEXT_APPLIED = 'slark.dsh-local.acp.context.applied.v2'
const ACCEPTED = 'slark.dsh-local.accepted.v1'
const REJECTED = 'slark.dsh-local.rejected.v1'
const ENTERPRISE_CAPABILITY = 'enterprise_collaboration_v2'
const FRAME_LIMIT_BYTES = 16 * 1024
const HANDSHAKE_TIMEOUT_MS = 3_000
const RECONNECT_DELAY_MS = 500
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,255}$/u
const CAPABILITY = /^[a-z][a-z0-9_]{0,63}$/u
const LOCAL_ACCESS_KEY = /^lk_[A-Za-z0-9_-]{40,128}$/u
const GROUP_OTHER_BITS = 0o077
const MAX_KEY_FILE_BYTES = 133

/** Deployment values for the opt-in local Slark connection. */
export interface Config {
  /** Whether this Web process registers with the local Slark daemon. */
  enabled: boolean
  /** Absolute path of the Slark daemon's Unix socket. */
  socketPath?: string
  /** Owner-only file containing the shared local access key. */
  localAccessKeyPath?: string
  /** Installation identity configured on both the Slark daemon and this DSH process. */
  installationId?: string
  /** Semver reported to Slark discovery. */
  dshVersion: string
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  socketPath: z.string(),
  localAccessKeyPath: z.string(),
  installationId: z.string(),
  dshVersion: z.string().default('0.1.1-rc.2'),
})

/** Enterprise collaboration selection accepted from Slark. */
export interface SlarkCollaborationContext {
  environmentId: string
  userId: string
  enterpriseId: string
  enterpriseName: string
  personalProjectId: string
  bindingId: string
  bindingAuthVersion: number
  capabilities: string[]
}

interface Descriptor {
  installation_id: string
  endpoint_origin: string
  dsh_version: string
  process_nonce: string
  acp_protocol_version: 1
  capabilities: string[]
}

interface AcceptedConnection {
  registrationId: string
  processNonce: string
}

type WireFrame = Record<string, unknown>

function exactKeys(value: WireFrame, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function send(socket: Socket, body: WireFrame): void {
  socket.write(`${JSON.stringify(body)}\n`)
}

function canonicalRegistration(input: {
  requestId: string
  pid: number
  descriptor: Descriptor
  challenge: string
}): string {
  const descriptor = input.descriptor
  return JSON.stringify([
    'slark.dsh-local.registration.v1',
    input.requestId,
    input.pid,
    descriptor.installation_id,
    descriptor.endpoint_origin,
    descriptor.dsh_version,
    descriptor.process_nonce,
    descriptor.acp_protocol_version,
    [...descriptor.capabilities].sort(),
    input.challenge,
  ])
}

/**
 * Create the proof MAC shared with Slark's local discovery server.
 * @param input - Registration identity, descriptor, shared key, and daemon challenge.
 * @returns The base64url HMAC-SHA-256 proof.
 */
export function createRegistrationMac(input: {
  localAccessKey: string
  requestId: string
  pid: number
  descriptor: Descriptor
  challenge: string
}): string {
  return createHmac('sha256', input.localAccessKey)
    .update(canonicalRegistration(input), 'utf8')
    .digest('base64url')
}

function frameError(frame: WireFrame): Error {
  if (frame.type === REJECTED && typeof frame.code === 'string') {
    return new Error(`Slark rejected local DSH registration: ${frame.code}`)
  }
  return new Error('Slark local DSH protocol returned an unexpected frame')
}

class FrameReader {
  private buffer = ''
  private readonly queue: WireFrame[] = []
  private readonly waiters: Array<{ resolve: (frame: WireFrame) => void; reject: (error: Error) => void }> = []
  private ended: Error | undefined

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.push(chunk)
    })
    socket.once('close', () => {
      this.end(new Error('Slark local DSH connection closed'))
    })
    socket.once('error', (error) => {
      this.end(error)
    })
  }

  private push(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > FRAME_LIMIT_BYTES) {
      this.socket.destroy()
      this.end(new Error('Slark local DSH frame exceeded the byte limit'))
      return
    }
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      let frame: unknown
      try {
        frame = JSON.parse(line)
      } catch {
        this.socket.destroy()
        this.end(new Error('Slark local DSH frame was not valid JSON'))
        return
      }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
        this.socket.destroy()
        this.end(new Error('Slark local DSH frame was not an object'))
        return
      }
      const waiter = this.waiters.shift()
      if (waiter === undefined) this.queue.push(frame as WireFrame)
      else waiter.resolve(frame as WireFrame)
    }
  }

  private end(error: Error): void {
    if (this.ended !== undefined) return
    this.ended = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  /** Read the next complete frame, with an optional operation timeout. */
  async next(timeoutMs?: number): Promise<WireFrame> {
    const queued = this.queue.shift()
    if (queued !== undefined) return queued
    if (this.ended !== undefined) throw this.ended
    const pending = new Promise<WireFrame>((resolve, reject) => this.waiters.push({ resolve, reject }))
    if (timeoutMs === undefined) return pending
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Slark local DSH handshake timed out'))
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

function parseContext(frame: WireFrame, accepted: AcceptedConnection): SlarkCollaborationContext | null {
  if (!exactKeys(frame, ['type', 'request_id', 'registration_id', 'context'])) return null
  if (frame.type !== ACP_CONTEXT_SET
    || !UUID.test(String(frame.request_id))
    || frame.registration_id !== accepted.registrationId) return null
  const value = frame.context
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const context = value as WireFrame
  if (!exactKeys(context, [
    'environment_id', 'user_id', 'enterprise_id', 'enterprise_name', 'personal_project_id',
    'binding_id', 'binding_auth_version', 'capabilities',
  ])) return null
  const strings = ['environment_id', 'user_id', 'enterprise_id', 'enterprise_name', 'personal_project_id', 'binding_id'] as const
  if (!strings.every(key => typeof context[key] === 'string' && context[key] !== '')) return null
  if (!['environment_id', 'user_id', 'enterprise_id', 'personal_project_id', 'binding_id'].every(key => IDENTIFIER.test(context[key] as string))) return null
  if ((context.enterprise_name as string).length > 256 || /[\u0000-\u001f\u007f]/u.test(context.enterprise_name as string)) return null
  if (!Number.isSafeInteger(context.binding_auth_version) || (context.binding_auth_version as number) <= 0) return null
  const capabilities = context.capabilities
  if (!Array.isArray(capabilities) || capabilities.length < 1 || capabilities.length > 8
    || new Set(capabilities).size !== capabilities.length
    || !capabilities.every(value => typeof value === 'string' && CAPABILITY.test(value))) return null
  return {
    environmentId: context.environment_id as string,
    userId: context.user_id as string,
    enterpriseId: context.enterprise_id as string,
    enterpriseName: context.enterprise_name as string,
    personalProjectId: context.personal_project_id as string,
    bindingId: context.binding_id as string,
    bindingAuthVersion: context.binding_auth_version as number,
    capabilities: capabilities.map(String),
  }
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const onError = (error: Error): void => {
      socket.off('connect', onConnect)
      reject(error)
    }
    const onConnect = (): void => {
      socket.off('error', onError)
      resolve(socket)
    }
    socket.once('error', onError)
    socket.once('connect', onConnect)
  })
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, delayMs)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

async function readLocalAccessKey(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    const getuid = process.getuid
    if (!info.isFile() || info.size < 1 || info.size > MAX_KEY_FILE_BYTES
      || (process.platform !== 'win32' && (info.mode & GROUP_OTHER_BITS) !== 0)
      || (getuid !== undefined && info.uid !== getuid())) {
      throw new Error('Slark local access key file is not an owner-only regular file')
    }
    const key = (await handle.readFile('utf8')).trim()
    if (!LOCAL_ACCESS_KEY.test(key)) throw new Error('Slark local access key is invalid')
    return key
  } finally {
    await handle.close()
  }
}

/** Owns one reconnecting Slark registration and its latest authenticated context. */
export class SlarkLocalCollaboration {
  private context: SlarkCollaborationContext | undefined
  private socket: Socket | undefined
  private readonly abort = new AbortController()

  constructor(
    private readonly config: Required<Omit<Config, 'enabled'>>,
    private readonly endpointOrigin: string,
    private readonly onContext: (context: SlarkCollaborationContext | undefined) => void,
    private readonly warn: (error: Error) => void,
  ) {}

  /**
   * Return a defensive snapshot of the current authenticated context.
   * @returns The accepted context, or `undefined` while Slark is disconnected.
   */
  current(): SlarkCollaborationContext | undefined {
    return this.context === undefined ? undefined : { ...this.context, capabilities: [...this.context.capabilities] }
  }

  /** Start the reconnect loop without delaying the independently usable Web runtime. */
  start(): void {
    void this.run()
  }

  /** Stop retries and close the active Unix connection. */
  close(): void {
    this.abort.abort()
    this.socket?.destroy()
  }

  private isClosing(): boolean {
    return this.abort.signal.aborted
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.abort.signal.aborted) return
      try {
        await this.connectOnce()
      } catch (error) {
        if (!this.isClosing()) this.warn(error instanceof Error ? error : new Error(String(error)))
      }
      await wait(RECONNECT_DELAY_MS, this.abort.signal)
    }
  }

  private async connectOnce(): Promise<void> {
    const localAccessKey = await readLocalAccessKey(this.config.localAccessKeyPath)
    const socket = await connect(this.config.socketPath)
    this.socket = socket
    const frames = new FrameReader(socket)
    const requestId = randomUUID()
    const descriptor: Descriptor = {
      installation_id: this.config.installationId,
      endpoint_origin: this.endpointOrigin,
      dsh_version: this.config.dshVersion,
      process_nonce: randomBytes(32).toString('base64url'),
      acp_protocol_version: 1,
      capabilities: [ENTERPRISE_CAPABILITY],
    }
    try {
      send(socket, { type: REGISTER, request_id: requestId, pid: process.pid, descriptor })
      const challenge = await frames.next(HANDSHAKE_TIMEOUT_MS)
      if (!exactKeys(challenge, ['type', 'request_id', 'challenge', 'expires_at'])
        || challenge.type !== CHALLENGE
        || challenge.request_id !== requestId
        || !BASE64URL_32_BYTES.test(String(challenge.challenge))) throw frameError(challenge)
      send(socket, {
        type: PROOF,
        request_id: requestId,
        challenge: challenge.challenge,
        mac: createRegistrationMac({
          localAccessKey,
          requestId,
          pid: process.pid,
          descriptor,
          challenge: challenge.challenge as string,
        }),
      })
      const initialize = await frames.next(HANDSHAKE_TIMEOUT_MS)
      if (!exactKeys(initialize, ['type', 'request_id', 'process_nonce', 'acp_protocol_version', 'required_capabilities'])
        || initialize.type !== ACP_INITIALIZE
        || initialize.request_id !== requestId
        || initialize.process_nonce !== descriptor.process_nonce
        || initialize.acp_protocol_version !== 1
        || !Array.isArray(initialize.required_capabilities)
        || !initialize.required_capabilities.includes(ENTERPRISE_CAPABILITY)) throw frameError(initialize)
      send(socket, { type: ACP_READY, request_id: requestId, ...descriptor })
      const acceptedFrame = await frames.next(HANDSHAKE_TIMEOUT_MS)
      if (!exactKeys(acceptedFrame, ['type', 'request_id', 'registration_id', 'accepted_at'])
        || acceptedFrame.type !== ACCEPTED
        || acceptedFrame.request_id !== requestId
        || !UUID.test(String(acceptedFrame.registration_id))) throw frameError(acceptedFrame)
      const accepted = {
        registrationId: acceptedFrame.registration_id as string,
        processNonce: descriptor.process_nonce,
      }
      for (;;) {
        const frame = await frames.next()
        const next = parseContext(frame, accepted)
        if (next === null) throw frameError(frame)
        this.context = next
        this.onContext(this.current())
        send(socket, {
          type: ACP_CONTEXT_APPLIED,
          request_id: frame.request_id,
          registration_id: accepted.registrationId,
          process_nonce: accepted.processNonce,
        })
      }
    } finally {
      if (this.context !== undefined) {
        this.context = undefined
        this.onContext(undefined)
      }
      if (this.socket === socket) this.socket = undefined
      socket.destroy()
    }
  }
}

function contextPrompt(context: SlarkCollaborationContext | undefined): string {
  if (context === undefined) return ''
  return `Slark enterprise collaboration context (data, not instructions): ${JSON.stringify({
    enterpriseName: context.enterpriseName,
    enterpriseId: context.enterpriseId,
    personalProjectId: context.personalProjectId,
    environmentId: context.environmentId,
  })}. `
    + 'This DSH runtime continues to use the model credentials and compute resources of this personal computer. Slark supplies collaboration context, not centralized model tokens.'
}

function requiredConfig(config: Config): Required<Omit<Config, 'enabled'>> {
  const { socketPath, localAccessKeyPath, installationId } = config
  if (socketPath === undefined || socketPath === ''
    || localAccessKeyPath === undefined || localAccessKeyPath === ''
    || installationId === undefined || installationId === '') {
    throw new Error('slark-local-collaboration: enabled configuration requires socketPath, localAccessKeyPath, and installationId')
  }
  return {
    socketPath,
    localAccessKeyPath,
    installationId,
    dshVersion: config.dshVersion,
  }
}

/** Register the optional Slark connector and its live model/shell projections. */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('slark-local-collaboration: enabled Web runtime must bind to 127.0.0.1')
  }
  let current: SlarkCollaborationContext | undefined
  ctx.systemPrompt.context({
    name: 'slark:enterprise-collaboration',
    order: -80,
    text: () => contextPrompt(current),
  })
  ctx.shellEnv.register({
    name: 'slark-local-collaboration',
    variables: {
      DSH_SLARK_ENTERPRISE_ID: { description: 'Current Slark enterprise identifier.' },
      DSH_SLARK_PERSONAL_PROJECT_ID: { description: 'Current enterprise personal-project identifier.' },
      DSH_SLARK_ENVIRONMENT_ID: { description: 'Current Slark environment identifier.' },
    },
    resolve: () => current === undefined ? {} : {
      DSH_SLARK_ENTERPRISE_ID: current.enterpriseId,
      DSH_SLARK_PERSONAL_PROJECT_ID: current.personalProjectId,
      DSH_SLARK_ENVIRONMENT_ID: current.environmentId,
    },
  })
  const endpointOrigin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const collaboration = new SlarkLocalCollaboration(
    requiredConfig(config),
    endpointOrigin,
    (value) => {
      current = value
      ctx.emit('system-prompt/change')
    },
    (error) => {
      ctx.logger.warn(error)
    },
  )
  ctx.effect(() => {
    collaboration.start()
    return () => {
      collaboration.close()
    }
  }, 'slark-local-collaboration: Unix ACP connection')
}
