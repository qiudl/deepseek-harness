/** Zero-content projection of durable DSH model invocations for Slark billing evidence. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-llm-retry'

export type UsageState = 'complete' | 'missing' | 'invalid'
export type CallTerminal = 'completed' | 'failed' | 'cancelled' | 'indeterminate' | 'max_tokens'

export interface SlarkInvocationContext {
  environmentId: string
  personalProjectId: string
  bindingId: string
  bindingAuthVersion: number
}

export interface SlarkUsageEnvelope {
  sample_id: string
  source_seq: number
  session_digest: string
  turn: number
  step: number
  attempt: number
  provider: string | null
  model: string | null
  uncached_input_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  output_tokens: number | null
  usage_state: UsageState
  call_terminal: CallTerminal
  turn_terminal: CallTerminal | null
  occurred_at: number
  environment_id: string
  personal_project_id: string
  binding_id: string
  binding_auth_version: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records one authenticated Slark-context model dispatch after its
     * zero-content identity and route prefix has passed a durability barrier.
     */
    'slark/invocation-start': {
      turn: number
      step: number
      attempt: number
      provider: string
      model: string
      context: SlarkInvocationContext
    }
    /** Records the daemon-durable sample revision that no longer needs replay. */
    'slark/usage-ack': { sampleId: string; sourceSeq: number }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function terminalFromTurn(kind: string): CallTerminal {
  switch (kind) {
    case 'completed': return 'completed'
    case 'aborted': return 'cancelled'
    case 'error': return 'failed'
    case 'max-tokens': return 'max_tokens'
    default: return 'indeterminate'
  }
}

function validToken(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/** Fold a canonical session log into deterministic, content-free invocation revisions. */
export function projectSlarkUsage(sessionId: SessionId | string, events: readonly SessionEvent[]): SlarkUsageEnvelope[] {
  const sessionDigest = digest(String(sessionId))
  const invocations: Array<Extract<SessionEvent, { type: 'slark/invocation-start' }>> = []
  const turnTerminals = new Map<number, { terminal: CallTerminal; seq: number; time: number }>()
  const acknowledged = new Set<string>()

  for (const event of events) {
    if (event.type === 'slark/invocation-start') {
      invocations.push(event)
    } else if (event.type === 'turn/end') {
      turnTerminals.set(event.data.turn, { terminal: terminalFromTurn(event.data.reason.kind), seq: event.seq, time: event.time })
    } else if (event.type === 'slark/usage-ack') {
      acknowledged.add(event.data.sampleId)
    }
  }

  const projected: SlarkUsageEnvelope[] = []
  for (const [index, invocation] of invocations.entries()) {
    const { turn, step, attempt, provider, model, context } = invocation.data
    const nextInvocation = invocations[index + 1]
    const boundary = nextInvocation?.data.turn === turn && nextInvocation.data.step === step
      ? nextInvocation.seq
      : Number.POSITIVE_INFINITY
    let observed: { event: SessionEvent; value: Record<string, unknown> } | undefined
    let retrySeq = -1
    for (const event of events) {
      if (event.seq <= invocation.seq || event.seq >= boundary) continue
      if (event.type === 'assistant/chunk' && event.data.turn === turn && event.data.step === step && event.data.chunk.type === 'usage') {
        observed = { event, value: event.data.chunk.usage as unknown as Record<string, unknown> }
      } else if (event.type === 'assistant/message' && event.data.turn === turn && event.data.step === step && event.data.usage !== undefined) {
        observed = { event, value: event.data.usage as unknown as Record<string, unknown> }
      } else if (event.type === 'llm/retry' && event.data.turn === turn && event.data.step === step) {
        retrySeq = event.seq
      }
    }
    const turnEnd = turnTerminals.get(turn)
    const isRetried = Number.isFinite(boundary)
    const sourceSeq = Math.max(invocation.seq, observed?.event.seq ?? -1, retrySeq, isRetried ? -1 : turnEnd?.seq ?? -1)
    const sourceEventTime = events.find(event => event.seq === sourceSeq)?.time
    const sampleId = digest(`${sessionDigest}:${turn}:${step}:${attempt}:${sourceSeq}`)
    if (acknowledged.has(sampleId)) continue
    const values = observed?.value
    const raw = values === undefined
      ? []
      : [values.inputTokens, values.cacheReadTokens ?? 0, values.cacheWriteTokens ?? 0, values.outputTokens]
    const usageState: UsageState = values === undefined ? 'missing' : raw.every(validToken) ? 'complete' : 'invalid'
    projected.push({
      sample_id: sampleId,
      source_seq: sourceSeq,
      session_digest: sessionDigest,
      turn,
      step,
      attempt,
      provider,
      model,
      uncached_input_tokens: usageState === 'complete' ? values?.inputTokens as number : null,
      cache_read_tokens: usageState === 'complete' ? (values?.cacheReadTokens ?? 0) as number : null,
      cache_write_tokens: usageState === 'complete' ? (values?.cacheWriteTokens ?? 0) as number : null,
      output_tokens: usageState === 'complete' ? values?.outputTokens as number : null,
      usage_state: usageState,
      call_terminal: isRetried ? 'failed' : turnEnd?.terminal ?? 'indeterminate',
      turn_terminal: isRetried ? null : turnEnd?.terminal ?? null,
      occurred_at: isRetried ? sourceEventTime ?? invocation.time : turnEnd?.time ?? observed?.event.time ?? invocation.time,
      environment_id: context.environmentId,
      personal_project_id: context.personalProjectId,
      binding_id: context.bindingId,
      binding_auth_version: context.bindingAuthVersion,
    })
  }
  return projected.sort((left, right) => left.source_seq - right.source_seq)
}

const SCAN_PAGE_SIZE = 100
const SEND_PAGE_SIZE = 100

/** Bounded cold-store scanner and durable ACK writer for the Unix reporter. */
export class SlarkUsageReporter {
  private cursor = 0
  private readonly sampleSessions = new Map<string, SessionId>()
  private wake = Promise.withResolvers<void>()

  constructor(private readonly ctx: Context, private readonly warn: (error: Error) => void) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      void ctx.sessions.flush(session).then(
        () => {
          this.notify()
        },
        (error: unknown) => {
          this.warn(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  }

  /** Wake a connected sender after newly durable terminal evidence appears. */
  notify(): void {
    this.wake.resolve()
    this.wake = Promise.withResolvers<void>()
  }

  /** Wait for new work or a bounded replay retry interval. */
  async wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.wake.promise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 500) }),
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve()
        }, { once: true })
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
  }

  /** Return one bounded page of unacknowledged, content-free revisions. */
  async pending(signal: AbortSignal): Promise<SlarkUsageEnvelope[]> {
    const snapshots = await this.ctx.sessionPersistence.listSnapshots(signal)
    if (snapshots.length === 0) return []
    if (this.cursor >= snapshots.length) this.cursor = 0
    const page = snapshots.slice(this.cursor, this.cursor + SCAN_PAGE_SIZE)
    this.cursor = (this.cursor + page.length) % snapshots.length
    const result: SlarkUsageEnvelope[] = []
    for (const snapshot of page) {
      signal.throwIfAborted()
      const inspection = await this.ctx.sessionPersistence.inspect(snapshot.header.id, signal)
      for (const sample of projectSlarkUsage(snapshot.header.id, inspection.events)) {
        this.sampleSessions.set(sample.sample_id, snapshot.header.id)
        result.push(sample)
        if (result.length >= SEND_PAGE_SIZE) return result
      }
    }
    return result
  }

  /** Persist a daemon-durable ACK in the same canonical session log. */
  async acknowledge(sampleId: string, sourceSeq: number): Promise<void> {
    const id = this.sampleSessions.get(sampleId)
    if (id === undefined) throw new Error('Slark usage ACK named an unknown sample')
    const live = this.ctx.sessions.get(id)
    if (live !== undefined) {
      if (!live.events.some(event => event.type === 'slark/usage-ack' && event.data.sampleId === sampleId)) {
        live.append('slark/usage-ack', { sampleId, sourceSeq })
        await this.ctx.sessions.flush(live)
      }
    } else {
      const inspection = await this.ctx.sessionPersistence.inspect(id)
      if (!inspection.events.some(event => event.type === 'slark/usage-ack' && event.data.sampleId === sampleId)) {
        await this.ctx.sessionPersistence.append(id, [{
          type: 'slark/usage-ack',
          seq: inspection.events.length,
          time: Date.now(),
          data: { sampleId, sourceSeq },
        }])
      }
    }
    this.sampleSessions.delete(sampleId)
  }
}
