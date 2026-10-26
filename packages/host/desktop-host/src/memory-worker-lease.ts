/** REQ-20261021-0013: quiescent teardown for one Host-owned HY worker exchange. */
import type { MemoryWorkerChannel } from './memory-worker-channel.ts'
import type { MemoryWorkerListener } from './memory-worker-listener.ts'
import type { MemoryWorkerLink } from './memory-worker-session.ts'
import { HostAuthorityError } from './types.ts'

type Channel = Pick<MemoryWorkerChannel, 'project' | 'query' | 'close'>
type Listener = Pick<MemoryWorkerListener, 'close'>

interface ProcessTermination {
  /** Request a bounded stop; the owner must escalate to forced termination if needed. */
  stop(): void
  readonly done: Promise<void>
}

/** Owns a peer-attested channel, its private listener, and a bounded process stop. */
export class MemoryWorkerLease implements MemoryWorkerLink {
  private closing: Promise<void> | undefined

  constructor(private readonly channel: Channel, private readonly listener: Listener,
    private readonly process: ProcessTermination) {}

  async project(items: Parameters<MemoryWorkerLink['project']>[0], nextOffset: number | null,
    signal: AbortSignal): Promise<void> {
    if (this.closing) throw new HostAuthorityError('unavailable')
    return this.channel.project(items, nextOffset, signal)
  }

  async query(text: string, limit: number,
    signal: AbortSignal): Promise<Awaited<ReturnType<MemoryWorkerLink['query']>>> {
    if (this.closing) throw new HostAuthorityError('unavailable')
    return this.channel.query(text, limit, signal)
  }

  /** Refuse new work, close ingress, request stop, then await process exit exactly once. */
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.stop())
    return this.closing
  }

  private async stop(): Promise<void> {
    const errors: unknown[] = []
    try { this.channel.close() } catch (error) { errors.push(error) }
    try { await this.listener.close() } catch (error) { errors.push(error) }
    try { this.process.stop() } catch (error) { errors.push(error) }
    try { await this.process.done } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'HY worker teardown failed')
  }
}
