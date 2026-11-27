import { createHash } from 'node:crypto'
import { PRIVATE_TWIN_CONTROL_CHUNK_BYTES, parseHostPrivateTwinResult,
  type HostPrivateTwinCommand } from '@deepseek-ai/dsh-host-control-protocol'
import { parsePrivateTwinWorkerReply, parsePrivateTwinWorkerResult,
  type PrivateTwinWorkerRequest, type PrivateTwinWorkerResult } from './private-twin-worker-protocol.ts'
import { HostAuthorityError } from './types.ts'

/** Main-private operations over a single authenticated Native connection. */
export interface PrivateTwinControlChannel {
  readonly profileId: string
  assertCurrent(): void
  claim(signal: AbortSignal): Promise<{ readonly request: PrivateTwinWorkerRequest | null }>
  check(ticket: string, signal: AbortSignal): Promise<{ readonly current: true }>
  finish(ticket: string, result: PrivateTwinWorkerResult, signal: AbortSignal): Promise<{ readonly completed: true }>
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const stale = (): never => { throw new HostAuthorityError('stale') }

/** Retain the expected Main-owned Profile, peer guard, and exact claim for all data transfer. */
export function createPrivateTwinControlChannel(input: Readonly<{
  profileId: string
  assertCurrent(): void
  call(command: HostPrivateTwinCommand, signal: AbortSignal): Promise<unknown>
}>): PrivateTwinControlChannel {
  const profileId = input.profileId
  let claimed: string | undefined
  const send = async (command: HostPrivateTwinCommand, signal: AbortSignal) => {
    input.assertCurrent(); signal.throwIfAborted()
    const result = parseHostPrivateTwinResult(await input.call(command, signal))
    input.assertCurrent(); signal.throwIfAborted()
    return result
  }
  return Object.freeze({
    profileId,
    assertCurrent: () => { input.assertCurrent() },
    async claim(signal: AbortSignal) {
      if (claimed !== undefined) return stale()
      const header = await send({ operation: 'claim' }, signal)
      if (header.state === 'idle') return { request: null }
      if (header.state !== 'claimed' || header.profile_id !== profileId) return stale()
      const { ticket } = header
      const bytes = Buffer.alloc(header.total_bytes)
      let offset = 0
      while (offset < bytes.length) {
        const result = await send({ operation: 'read', ticket, offset }, signal)
        if (result.state !== 'chunk' || result.ticket !== ticket || result.offset !== offset) return stale()
        const part = Buffer.from(result.bytes, 'base64url')
        if (part.length !== Math.min(PRIVATE_TWIN_CONTROL_CHUNK_BYTES, bytes.length - offset)) return stale()
        part.copy(bytes, offset)
        offset += part.length
      }
      if (digest(bytes) !== header.digest) return stale()
      const request: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      const worker = parsePrivateTwinWorkerReply({ operation: 'claim' }, { request })
      if (worker.request?.ticket !== ticket) return stale()
      claimed = ticket
      return { request: worker.request }
    },
    async check(ticket: string, signal: AbortSignal) {
      if (claimed !== ticket) return stale()
      const result = await send({ operation: 'check', ticket }, signal)
      if (result.state !== 'current' || result.ticket !== ticket) return stale()
      return { current: true as const }
    },
    async finish(ticket: string, result: PrivateTwinWorkerResult, signal: AbortSignal) {
      if (claimed !== ticket) return stale()
      const bytes = Buffer.from(JSON.stringify(parsePrivateTwinWorkerResult(result)), 'utf8')
      // The validated result is a nonempty JSON object within the wire limit.
      const header = { ticket, total_bytes: bytes.length, digest: digest(bytes) }
      let offset = 0
      while (true) {
        const part = bytes.subarray(offset, offset + PRIVATE_TWIN_CONTROL_CHUNK_BYTES)
        const reply = await send({ operation: 'finish', ...header, offset, bytes: part.toString('base64url') }, signal)
        const nextOffset = offset + part.length
        if (nextOffset === bytes.length) {
          if (reply.state !== 'completed' || reply.ticket !== ticket) return stale()
          claimed = undefined
          return { completed: true as const }
        }
        if (reply.state !== 'staged' || reply.ticket !== ticket || reply.next_offset !== nextOffset) return stale()
        offset = nextOffset
      }
    },
  })
}
