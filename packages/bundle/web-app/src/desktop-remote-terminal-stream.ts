import type { DesktopRemoteGateway } from './desktop-remote-gateway.ts'
/** One-use terminal stream permits issued only after native Session control validation. */
import { randomUUID } from 'node:crypto'
import type { HostRemoteSessionCommand } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopSessionCredential } from './desktop-session-control.ts'
import { DesktopSessionControl } from './desktop-session-control.ts'

type Command = Extract<HostRemoteSessionCommand, { operation: 'terminal.apply' }>
type Input = { type: 'write'; sequence: number; data: string } | { type: 'resize'; sequence: number; cols: number; rows: number }

class BoundedChannel<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private bytes = 0
  private waiter: { resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void } | undefined
  private ended = false
  private failure: Error | undefined

  push(value: T): void {
    if (this.ended) throw new Error('terminal attachment closed')
    if (this.waiter) {
      const waiter = this.waiter; this.waiter = undefined
      waiter.resolve({ done: false, value })
    } else {
      const bytes = Buffer.byteLength(JSON.stringify(value))
      if (this.items.length >= 32 || this.bytes + bytes > 2 * 1024 * 1024) throw new Error('terminal attachment buffer full')
      this.items.push(value)
      this.bytes += bytes
    }
  }

  close(error?: Error): void {
    if (this.ended) return
    this.ended = true; this.failure = error
    if (error) { this.items.length = 0; this.bytes = 0 }
    const waiter = this.waiter; this.waiter = undefined
    if (waiter) {
      if (error) waiter.reject(error)
      else waiter.resolve({ done: true, value: undefined })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) {
          this.bytes -= Buffer.byteLength(JSON.stringify(item))
          return Promise.resolve({ done: false, value: item })
        }
        if (this.failure) return Promise.reject(this.failure)
        if (this.ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve, reject) => { this.waiter = { resolve, reject } })
      },
      return: () => { this.close(); return Promise.resolve({ done: true, value: undefined }) },
    }
  }
}

interface Attachment {
  readonly permit: Permit
  readonly input: BoundedChannel<Input>
  readonly output: BoundedChannel<unknown>
  readonly lifetime: AbortController
  readonly pending: Map<number, { resolve: () => void; reject: (error: Error) => void }>
  sequence: number
}
interface Permit {
  readonly sessionId: string
  readonly proof: DesktopSessionCredential
  readonly method: 'follow' | 'retain'
  readonly args: Command['request']['args']
  readonly expiresAt: number
}
/** Profile-local permits preserve the original terminal attachment and Session proof. */
export class DesktopRemoteTerminalStreams {
  private readonly permits = new Map<string, Permit>()
  private readonly attachments = new Map<string, Attachment>()
  private readonly uncertain = new Map<string, DesktopSessionCredential>()
  private active = 0
  constructor(private readonly control: DesktopSessionControl, private readonly now: () => number = Date.now) {}

  private key(sessionId: string, args: Command['request']['args']): string {
    return JSON.stringify([sessionId, args.id, args.attachmentId])
  }

  /**
   * Forward a controlled input and wait for the matching acknowledgement.
   * @param command - Input bound to the active Session and attachment.
   * @param signal - Cancellation of the native request.
   */
  async send(command: Command, signal: AbortSignal): Promise<void> {
    const attachment = this.attachments.get(this.key(command.session_id, command.request.args))
    const proof: DesktopSessionCredential = { kind: 'remote', id: command.control.controller_id,
      generation: command.control.generation, epoch: command.control.epoch }
    this.control.assertWrite(command.session_id, proof)
    if (this.uncertain.has(command.session_id)) throw new Error('terminal input result unknown')
    if (!attachment || attachment.permit.proof.id !== proof.id || attachment.permit.proof.generation !== proof.generation
      || attachment.permit.proof.epoch !== proof.epoch) throw new Error('terminal attachment unavailable')
    signal.throwIfAborted()
    const { method, args } = command.request
    if (method !== 'write' && method !== 'resize') throw new Error('terminal input method denied')
    if (method === 'write' && typeof args.data !== 'string') throw new Error('invalid terminal input')
    if (attachment.pending.size >= 16) throw new Error('terminal input queue full')
    const sequence = ++attachment.sequence
    const input: Input = method === 'write'
      ? { type: 'write', sequence, data: args.data as string }
      : { type: 'resize', sequence, cols: Number(args.cols), rows: Number(args.rows) }
    const result = new Promise<void>((resolve, reject) => { attachment.pending.set(sequence, { resolve, reject }) })
    const abort = () => {
      const error = new Error('terminal input result unknown')
      this.uncertain.set(command.session_id, attachment.permit.proof)
      attachment.lifetime.abort(error)
      for (const pending of attachment.pending.values()) pending.reject(error)
      attachment.pending.clear()
    }
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 25_000); timeout.unref()
    try {
      try { attachment.input.push(input) } catch (error) { attachment.lifetime.abort(error); throw error }
      await result
    } finally {
      attachment.pending.delete(sequence); clearTimeout(timeout); signal.removeEventListener('abort', abort)
    }
  }

  /**
   * Issue one short permit while the enclosing command holds native Session control.
   * @param command Validated terminal follow/retain intent.
   * @returns A random one-use handle without a transferable control proof.
   */
  issue(command: Command): { grantId: string } {
    if (command.request.method !== 'follow' && command.request.method !== 'retain') throw new Error('terminal stream method denied')
    for (const [id, permit] of this.permits) if (permit.expiresAt <= this.now()) this.permits.delete(id)
    if (this.permits.size >= 16) throw new Error('terminal stream permits full')
    const proof: DesktopSessionCredential = { kind: 'remote', id: command.control.controller_id,
      generation: command.control.generation, epoch: command.control.epoch }
    this.control.assertWrite(command.session_id, proof)
    const uncertain = this.uncertain.get(command.session_id)
    const sameClaim = uncertain && uncertain.id === proof.id && uncertain.generation === proof.generation && uncertain.epoch === proof.epoch
    if (sameClaim && command.request.method === 'follow') throw new Error('terminal input result unknown')
    if (uncertain && !sameClaim) this.uncertain.delete(command.session_id)
    const grantId = randomUUID()
    this.permits.set(grantId, { sessionId: command.session_id, proof,
      method: command.request.method, args: structuredClone(command.request.args), expiresAt: this.now() + 10_000 })
    return { grantId }
  }

  /**
   * Consume a permit, recheck control while idle and before each output, and release only the attachment.
   * @param gateway The same Profile's original terminal Gateway.
   * @param grantId One-use handle returned by issue.
   * @param signal View/transport cancellation; shell lifetime remains owned by terminalController.
   * @returns Original terminal frames with existing Gateway semantics.
   */
  async *open(gateway: DesktopRemoteGateway, grantId: string, signal: AbortSignal): AsyncGenerator {
    const permit = this.permits.get(grantId)
    this.permits.delete(grantId)
    if (!permit || permit.expiresAt <= this.now() || this.active >= 8) throw new Error('terminal stream unavailable')
    signal.throwIfAborted()
    const release = this.control.beginWrite(permit.sessionId, permit.proof)
    const lifetime = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal])
    const check = () => { combined.throwIfAborted(); this.control.assertWrite(permit.sessionId, permit.proof) }
    const timer = setInterval(() => {
      try { check() } catch (error) { lifetime.abort(error) }
    }, 1000)
    timer.unref()
    this.active += 1
    try {
      check()
      if (permit.method === 'follow') {
        if (this.uncertain.has(permit.sessionId)) throw new Error('terminal input result unknown')
        const key = this.key(permit.sessionId, permit.args)
        if (this.attachments.has(key)) throw new Error('terminal attachment already active')
        const attachment: Attachment = { permit, input: new BoundedChannel(), output: new BoundedChannel(), lifetime,
          pending: new Map(), sequence: 0 }
        this.attachments.set(key, attachment)
        const pump = (async () => {
          let failure: Error | undefined
          try {
            const source = await gateway.wireStream.open('terminal/attach', { args: { agentId: permit.args.agentId, id: permit.args.id } },
              attachment.input, undefined, combined)
            for await (const value of source) {
              check()
              if (value && typeof value === 'object' && 'type' in value && value.type === 'ack' && 'sequence' in value && typeof value.sequence === 'number') {
                const pending = attachment.pending.get(value.sequence)
                if (!pending) throw new Error('unexpected terminal acknowledgement')
                if ('refusal' in value && value.refusal !== undefined) {
                  if (value.refusal !== 'read-only' && value.refusal !== 'not-running') throw new Error('invalid terminal refusal')
                  attachment.pending.delete(value.sequence)
                  pending.reject(Object.assign(new Error('terminal input refused'), { isDSHRemoteError: true,
                    code: 'terminal/control-unavailable', details: { reason: value.refusal } }))
                } else { attachment.pending.delete(value.sequence); pending.resolve() }
              } else attachment.output.push(value)
            }
          } catch (error) { failure = error instanceof Error ? error : new Error(String(error)) }
          finally {
            const error = failure ?? new Error('terminal attachment closed')
            if (failure) lifetime.abort(error)
            if (attachment.pending.size > 0) this.uncertain.set(permit.sessionId, permit.proof)
            for (const pending of attachment.pending.values()) pending.reject(error)
            attachment.pending.clear(); attachment.input.close(); attachment.output.close(failure)
            this.attachments.delete(key)
          }
        })()
        try { for await (const value of attachment.output) { release(); check(); yield value } }
        finally { lifetime.abort(); attachment.input.close(); await pump }
        return
      }
      const source = await gateway.stream({ namespace: 'terminal', method: permit.method, args: permit.args, signal: combined })
      for await (const value of source) {
        release()
        check()
        yield value
      }
    } finally {
      release()
      clearInterval(timer)
      lifetime.abort()
      this.active -= 1
    }
  }
}
