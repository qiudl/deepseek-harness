/** REQ-20261023-0013: accept one Slark Agent result chunk under current Host authority. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { botGroupHostRegistryId, decoded, issuerOrigin,
  type BotGroupPublicKeyring } from './bot-group-ticket.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SLARK_USER = /^[\x21-\x7e]{1,256}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const OPAQUE = /^[\x21-\x7e]{1,256}$/u
const AUDIENCE = 'urn:slark:dsh-native-agent-result:v1'
const FIELDS = ['schema_version', 'issuer', 'audience', 'slark_audience',
  'environment_id', 'owner_user_id', 'computer_id', 'account_issuer',
  'account_subject', 'account_binding_epoch', 'host_registry_id',
  'group_id', 'workspace_id', 'session_id', 'room_id', 'member_id',
  'member_cycle', 'turn_id', 'turn_order', 'trigger_room_seq',
  'project_id', 'agent_id', 'reply_message_id', 'status', 'result_digest',
  'chunk_index', 'chunk_count', 'chunk_digest', 'token_id', 'issued_at',
  'expires_at'] as const
const fail = (): never => { throw Error('native_agent_result_ticket_invalid') }
const runtimeArray = (value: unknown): boolean => Array.isArray(value)
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const coordinate = (value: unknown): value is string => typeof value === 'string' &&
  OPAQUE.test(value) && !/[/\\]/u.test(value) && value !== '.' && value !== '..'
function origin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value }
  catch { return false }
}

export interface NativeAgentResultExpected {
  readonly computerId: string
  readonly accountIssuer: string
  readonly accountSubject: string
  readonly environmentId: string
  readonly accountBindingHandle: string
  readonly accountBindingEpoch: number
  readonly installationId: string
  readonly slarkAudience: string
  readonly groupId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly roomId: string
  readonly memberId: string
  readonly memberCycle: number
  readonly turnId: string
  readonly turnOrder: number
  readonly triggerRoomSeq: number
  readonly projectId: string
  readonly agentId: string
  readonly replyMessageId: string
  readonly status: 'completed' | 'failed'
  readonly resultDigest: string
  readonly chunkIndex: number
  readonly chunkCount: number
  readonly chunkText: string
}

export function nativeAgentResultDigest(input: Pick<NativeAgentResultExpected,
  'groupId' | 'turnId' | 'replyMessageId' | 'status'> & { text: string }): string {
  return createHash('sha256').update(JSON.stringify(['dsh-native-agent-result-v1',
    input.groupId, input.turnId, input.replyMessageId, input.status, input.text])).digest('hex')
}

export function nativeAgentResultChunkDigest(input: Pick<NativeAgentResultExpected,
  'turnId' | 'chunkIndex' | 'chunkCount' | 'chunkText'>): string {
  return createHash('sha256').update(JSON.stringify(['dsh-native-agent-chunk-v1',
    input.turnId, input.chunkIndex, input.chunkCount, input.chunkText])).digest('hex')
}

/** Exact signed fields and pinned environment key are required; no online state is inferred. */
export function verifyNativeAgentResultTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: NativeAgentResultExpected, now = Date.now()): number {
  if (typeof token !== 'string' || Buffer.byteLength(token) > 8192) fail()
  const parts = token.split('.')
  if (parts.length !== 3) fail()
  try {
    const [headerPart, claimsPart, signaturePart] = parts as [string, string, string]
    const header = decoded(headerPart), claims = decoded(claimsPart)
    if (!exact(header, ['alg', 'typ', 'version', 'kid']) || !exact(claims, FIELDS) ||
        header.alg !== 'EdDSA' || header.typ !== 'SLARK-DSH-NATIVE-AGENT-RESULT' ||
        header.version !== 1 || typeof header.kid !== 'string' ||
        claims.schema_version !== 1 || claims.issuer !== keyring.issuer ||
        claims.audience !== AUDIENCE || !origin(expected.slarkAudience) ||
        claims.slark_audience !== expected.slarkAudience ||
        issuerOrigin(keyring.issuer) !== expected.slarkAudience ||
        !UUID.test(keyring.environmentId) || claims.environment_id !== keyring.environmentId ||
        claims.environment_id !== expected.environmentId ||
        typeof claims.owner_user_id !== 'string' || !SLARK_USER.test(claims.owner_user_id) ||
        claims.computer_id !== expected.computerId ||
        claims.account_issuer !== expected.accountIssuer || !origin(expected.accountIssuer) ||
        claims.account_subject !== expected.accountSubject || !UUID.test(expected.accountSubject) ||
        claims.account_binding_epoch !== expected.accountBindingEpoch ||
        claims.host_registry_id !== botGroupHostRegistryId({ ...expected,
          ownerUserId: claims.owner_user_id }) ||
        claims.group_id !== expected.groupId || !UUID.test(expected.groupId) ||
        claims.workspace_id !== expected.workspaceId || !UUID.test(expected.workspaceId) ||
        claims.session_id !== expected.sessionId || !coordinate(expected.sessionId) ||
        claims.room_id !== expected.roomId || !coordinate(expected.roomId) ||
        claims.member_id !== expected.memberId || !UUID.test(expected.memberId) ||
        claims.member_cycle !== expected.memberCycle || !positive(expected.memberCycle) ||
        claims.turn_id !== expected.turnId || !UUID.test(expected.turnId) ||
        claims.turn_order !== expected.turnOrder || !positive(expected.turnOrder) ||
        claims.trigger_room_seq !== expected.triggerRoomSeq || !positive(expected.triggerRoomSeq) ||
        claims.project_id !== expected.projectId || !OPAQUE.test(expected.projectId) ||
        claims.agent_id !== expected.agentId || !OPAQUE.test(expected.agentId) ||
        claims.reply_message_id !== expected.replyMessageId || !OPAQUE.test(expected.replyMessageId) ||
        claims.status !== expected.status ||
        claims.result_digest !== expected.resultDigest || !DIGEST.test(expected.resultDigest) ||
        claims.chunk_index !== expected.chunkIndex || !Number.isSafeInteger(expected.chunkIndex) ||
        expected.chunkIndex < 0 || claims.chunk_count !== expected.chunkCount ||
        !positive(expected.chunkCount) || expected.chunkCount > 100 ||
        expected.chunkIndex >= expected.chunkCount ||
        claims.chunk_digest !== nativeAgentResultChunkDigest(expected) ||
        typeof expected.chunkText !== 'string' ||
        Buffer.byteLength(JSON.stringify(expected.chunkText)) > 14_000 ||
        !UUID.test(String(claims.token_id)) || !positive(claims.issued_at) ||
        !positive(claims.expires_at) || claims.issued_at > now + 5_000 ||
        claims.expires_at <= now || claims.expires_at <= claims.issued_at ||
        claims.expires_at - claims.issued_at > 60_000) return fail()
    const keys = keyring.keys
    if (!runtimeArray(keys) || keys.length < 1 || keys.length > 4) return fail()
    const selected = keys.find(key => key.kid === header.kid)
    if (!selected || keys.some(key => key.kid === selected.kid && key !== selected) ||
        selected.validFrom > claims.issued_at ||
        selected.validUntil < claims.expires_at) return fail()
    const publicKey = createPublicKey(selected.publicKeyPem)
    const signature = Buffer.from(signaturePart, 'base64url')
    if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64 ||
        signature.toString('base64url') !== signaturePart ||
        !verify(null, Buffer.from(`${headerPart}.${claimsPart}`, 'ascii'), publicKey, signature)) return fail()
    return claims.expires_at
  } catch { return fail() }
}

/** Recheck the same ticket at Slark immediately before any plugin result write. */
export async function confirmNativeAgentResultTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: NativeAgentResultExpected, signal: AbortSignal,
  fetchFn: typeof fetch = fetch, clock: () => number = Date.now): Promise<number> {
  const expiresAt = verifyNativeAgentResultTicket(token, keyring, expected, clock())
  if (signal.aborted) fail()
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  try {
    const response = await fetchFn(expected.slarkAudience +
      '/api/v1/dsh/collaboration-v2/group-messages/native-result-confirm', {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, 'cache-control': 'no-store' }, signal: bounded,
    })
    if (response.status !== 200 || !response.body) return fail()
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let bytes = 0
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 4096) { await reader.cancel(); fail() }
      parts.push(part.value)
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(parts)))
    if (!exact(body, ['ok', 'value']) || body.ok !== true ||
        !exact(body.value, ['state', 'turn_id', 'chunk_index', 'expires_at']) ||
        body.value.state !== 'authorized' || body.value.turn_id !== expected.turnId ||
        body.value.chunk_index !== expected.chunkIndex || body.value.expires_at !== expiresAt ||
        bounded.aborted || clock() >= expiresAt) fail()
    return expiresAt
  } catch { return fail() }
}
