import { createHash } from 'node:crypto'
import { PRIVATE_TWIN_CONTROL_CHUNK_BYTES, PRIVATE_TWIN_CONTROL_REQUEST_BYTES, parseHostPrivateTwinCommand,
  parseHostPrivateTwinResult, type HostPrivateTwinCommand, type HostPrivateTwinResult } from '@deepseek-ai/dsh-host-control-protocol'
import { parsePrivateTwinWorkerReply, parsePrivateTwinWorkerResult, type PrivateTwinWorkerCommand,
  type PrivateTwinWorkerReply } from './private-twin-worker-protocol.ts'
import { HostAuthorityError } from './types.ts'

/** A capability pinned by the supervisor to one worker generation. */
export interface PrivateTwinWorkerReceiver {
  assertCurrent(): void
  operate(command: PrivateTwinWorkerCommand, signal: AbortSignal): Promise<PrivateTwinWorkerReply>
}

interface TransferAuthority {
  readonly key: string
  readonly signal: AbortSignal
  authorize(): string
  capture(profile: string): PrivateTwinWorkerReceiver
}

interface Lease {
  readonly key: string
  readonly profile: string
  readonly ticket: string
  readonly request: Buffer
  readonly receiver: PrivateTwinWorkerReceiver
  readonly lifetime: AbortSignal
  upload?: { readonly bytes: Buffer; readonly digest: string; offset: number }
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const stale = (): never => { throw new HostAuthorityError('stale') }

/** Own at most one claimed invocation on this authenticated Native connection. */
export class PrivateTwinTransfer {
  private lease: Lease | undefined
  private busy = false

  constructor(private readonly connection: AbortSignal) {}

  /** Release buffered content when the authenticated connection closes. */
  clear(): void { this.lease = undefined }

  /** Process a claim, an authorization check, or one bounded chunk under the same Account and worker. */
  async execute(raw: HostPrivateTwinCommand, authority: TransferAuthority): Promise<HostPrivateTwinResult> {
    authority.signal.throwIfAborted()
    this.connection.throwIfAborted()
    const command = parseHostPrivateTwinCommand(raw)
    const profile = authority.authorize()
    if (this.busy) throw new HostAuthorityError('busy')
    this.busy = true
    try {
      if (this.lease?.lifetime.aborted || (this.lease?.key === authority.key && this.lease.profile !== profile)) this.clear()
      if (command.operation === 'claim') return await this.claim(authority, profile)
      const lease = this.lease
      if (!lease || lease.ticket !== command.ticket || lease.key !== authority.key) return stale()
      const signal = AbortSignal.any([authority.signal, this.connection, lease.lifetime])
      const guard = () => {
        signal.throwIfAborted()
        if (this.lease !== lease || profile !== lease.profile || authority.authorize() !== lease.profile) stale()
        lease.receiver.assertCurrent()
      }
      try {
        guard()
        const check = { operation: 'check', ticket: lease.ticket } as const
        parsePrivateTwinWorkerReply(check, await lease.receiver.operate(check, signal))
        guard()
        if (command.operation === 'check') return { state: 'current', ticket: lease.ticket }
        if (command.operation === 'read') {
          if (command.offset >= lease.request.length) return stale()
          const bytes = lease.request.subarray(command.offset, command.offset + PRIVATE_TWIN_CONTROL_CHUNK_BYTES)
          return { state: 'chunk', ticket: lease.ticket, offset: command.offset, bytes: bytes.toString('base64url') }
        }
        const part = Buffer.from(command.bytes, 'base64url')
        const upload = lease.upload ??= { bytes: Buffer.alloc(command.total_bytes), digest: command.digest, offset: 0 }
        if (command.offset !== upload.offset || command.total_bytes !== upload.bytes.length || command.digest !== upload.digest)
          return stale()
        part.copy(upload.bytes, upload.offset)
        upload.offset += part.length
        if (upload.offset < upload.bytes.length) return { state: 'staged', ticket: lease.ticket, next_offset: upload.offset }
        if (digest(upload.bytes) !== upload.digest) return stale()
        const result = parsePrivateTwinWorkerResult(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(upload.bytes)))
        const finish = { operation: 'finish', ticket: lease.ticket, result } as const
        guard()
        parsePrivateTwinWorkerReply(finish, await lease.receiver.operate(finish, signal))
        guard()
        this.lease = undefined
        return { state: 'completed', ticket: lease.ticket }
      } catch (error) {
        this.lease = undefined
        throw error
      }
    } finally { this.busy = false }
  }

  private async claim(authority: TransferAuthority, profile: string): Promise<HostPrivateTwinResult> {
    if (this.lease) throw new HostAuthorityError('busy')
    const lifetime = AbortSignal.timeout(20_000)
    const signal = AbortSignal.any([this.connection, authority.signal, lifetime])
    const receiver = authority.capture(profile)
    receiver.assertCurrent()
    const command = { operation: 'claim' } as const
    const response = parsePrivateTwinWorkerReply(command, await receiver.operate(command, signal))
    signal.throwIfAborted()
    if (authority.authorize() !== profile) return stale()
    receiver.assertCurrent()
    if (!('request' in response)) return stale()
    if (response.request === null) return { state: 'idle' }
    const request = Buffer.from(JSON.stringify(response.request), 'utf8')
    if (request.length > PRIVATE_TWIN_CONTROL_REQUEST_BYTES) throw new HostAuthorityError('unavailable')
    const ticket = response.request.ticket
    const result = parseHostPrivateTwinResult({ state: 'claimed', profile_id: profile, ticket,
      total_bytes: request.length, digest: digest(request) })
    const lease: Lease = { key: authority.key, profile, ticket, request, receiver, lifetime }
    this.lease = lease
    lifetime.addEventListener('abort', () => { if (this.lease === lease) this.lease = undefined }, { once: true })
    return result
  }
}
