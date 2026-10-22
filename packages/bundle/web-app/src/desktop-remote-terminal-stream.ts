/** One-use terminal stream permits issued only after native Session control validation. */
import { randomUUID } from 'node:crypto'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { HostRemoteSessionCommand } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopSessionCredential } from './desktop-session-control.ts'
import { DesktopSessionControl } from './desktop-session-control.ts'

type Command = Extract<HostRemoteSessionCommand, { operation: 'terminal.apply' }>
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
  private active = 0
  constructor(private readonly control: DesktopSessionControl, private readonly now: () => number = Date.now) {}

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
  async *open(gateway: TypertGateway, grantId: string, signal: AbortSignal): AsyncGenerator {
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
