import { createHash } from 'node:crypto'
import { PRIVATE_TWIN_CONTROL_CHUNK_BYTES, parseHostPrivateTwinResult,
  parseHostBindingRegistration, type HostPrivateTwinCommand, type HostBindingIntentProof,
  type HostBindingRegistration } from '@deepseek-ai/dsh-host-control-protocol'
import { parsePrivateTwinWorkerReply, parsePrivateTwinWorkerResult,
  type PrivateTwinWorkerRequest, type PrivateTwinWorkerResult } from './private-twin-worker-protocol.ts'
import { HostAuthorityError } from './types.ts'

/** Main-private operations over a single authenticated Native connection. */
export interface PrivateTwinControlChannel {
  readonly profileId: string
  assertCurrent(): void
  claim(signal: AbortSignal): Promise<{ readonly request: PrivateTwinWorkerRequest | null; readonly bindingProfileEpoch?: number }>
  check(ticket: string, signal: AbortSignal): Promise<{ readonly current: true }>
  signBindingIntent(ticket: string, registration: HostBindingRegistration, signal: AbortSignal): Promise<HostBindingIntentProof>
  finish(ticket: string, result: PrivateTwinWorkerResult, signal: AbortSignal): Promise<{ readonly completed: true }>
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const stale = (): never => { throw new HostAuthorityError('stale') }

/** Retain the expected Main-owned Profile, peer guard, and exact claim for all data transfer. */
export function createPrivateTwinControlChannel(input: Readonly<{
  profileId: string
  includeBindingProfileEpoch?: boolean
  verifyBindingIntent?(proof: HostBindingIntentProof): void
  assertCurrent(): void
  call(command: HostPrivateTwinCommand, signal: AbortSignal): Promise<unknown>
}>): PrivateTwinControlChannel {
  const profileId = input.profileId
  let claimed: PrivateTwinWorkerRequest | undefined
  let bindingProfileEpoch: number | undefined
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
      const header = await send({ operation: 'claim', ...(input.includeBindingProfileEpoch ? { binding_profile_epoch: true } : {}) }, signal)
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
      const wantsEpoch = Boolean(input.includeBindingProfileEpoch && worker.request.operation.startsWith('binding_'))
      if (wantsEpoch !== (header.binding_profile_epoch !== undefined)) return stale()
      claimed = worker.request
      bindingProfileEpoch = header.binding_profile_epoch
      return { request: worker.request, ...(bindingProfileEpoch === undefined ? {} : { bindingProfileEpoch }) }
    },
    async check(ticket: string, signal: AbortSignal) {
      if (claimed?.ticket !== ticket) return stale()
      const result = await send({ operation: 'check', ticket }, signal)
      if (result.state !== 'current' || result.ticket !== ticket) return stale()
      return { current: true as const }
    },
    async signBindingIntent(ticket: string, rawRegistration: HostBindingRegistration, signal: AbortSignal) {
      if (!input.verifyBindingIntent) throw new HostAuthorityError('upgrade_required')
      const request = claimed
      if (!request || request.ticket !== ticket || request.operation !== 'binding_intent')
        throw new HostAuthorityError('unauthorized')
      const registration = parseHostBindingRegistration(rawRegistration)
      const result = await send({ operation: 'sign_binding', ticket, registration }, signal)
      if (result.state !== 'binding_intent' || result.ticket !== ticket || claimed !== request)
        return stale()
      const { proof } = result, { claims } = proof
      if (claims.profileId !== profileId || (bindingProfileEpoch !== undefined && claims.profileEpoch !== bindingProfileEpoch) ||
          claims.mainBotId !== request.botId ||
          claims.sessionId !== request.sessionId || claims.messageId !== request.sourceMessageId ||
          claims.expiresAt > request.intent.expiresAt ||
          (['requestId', 'messageSeq', 'messageDigest', 'previewDigest', 'commandDigest'] as const)
            .some(key => claims[key] !== request.intent[key]) ||
          (Object.keys(registration) as Array<keyof HostBindingRegistration>)
            .some(key => claims[key] !== registration[key])) return stale()
      input.verifyBindingIntent(proof)
      return proof
    },
    async finish(ticket: string, result: PrivateTwinWorkerResult, signal: AbortSignal) {
      if (claimed?.ticket !== ticket) return stale()
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
          bindingProfileEpoch = undefined
          return { completed: true as const }
        }
        if (reply.state !== 'staged' || reply.ticket !== ticket || reply.next_offset !== nextOffset) return stale()
        offset = nextOffset
      }
    },
  })
}
