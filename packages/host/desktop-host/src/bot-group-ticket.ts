/** Verify one Slark-signed Bot group delivery before touching the Profile worker. */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const BOT = /^[A-Za-z0-9_-]{1,200}$/u
const SLARK_USER = /^[\x21-\x7e]{1,256}$/u
const DIGEST = /^[0-9a-f]{64}$/u
const SEGMENT = /^[A-Za-z0-9_-]+$/u
const REGISTRY = /^h2_[0-9a-f]{64}$/u
const AUDIENCE = 'urn:slark:dsh-bot-group-delivery:v1'
const STOP_AUDIENCE = 'urn:slark:dsh-bot-group-stop:v1'
const RESULT_AUDIENCE = 'urn:slark:dsh-bot-group-result:v1'
const CLAIMS = ['schema_version', 'issuer', 'audience', 'slark_audience', 'environment_id',
  'owner_user_id', 'computer_id', 'account_issuer', 'account_subject', 'account_binding_epoch',
  'host_registry_id', 'group_id', 'workspace_id', 'session_id', 'delivery_id',
  'message_id', 'message_seq', 'bot_id', 'member_cycle', 'payload_digest',
  'token_id', 'issued_at', 'expires_at'] as const
const STOP_CLAIMS = [...CLAIMS, 'decision_request_id'] as const
const RESULT_CLAIMS = [...CLAIMS, 'decision_request_id'] as const

interface BotGroupPublicKey {
  readonly kid: string
  readonly publicKeyPem: string
  readonly validFrom: number
  readonly validUntil: number
}
interface VerifiedKey {
  key: KeyObject
  validFrom: number
  validUntil: number
}
export interface BotGroupPublicKeyring {
  readonly version: 1
  readonly environmentId: string
  readonly issuer: string
  readonly keys: readonly BotGroupPublicKey[]
}
export interface BotGroupTicketExpected {
  readonly computerId: string
  readonly accountIssuer: string
  readonly accountSubject: string
  readonly environmentId: string
  readonly accountBindingHandle: string
  readonly accountBindingEpoch: number
  readonly installationId: string
  readonly slarkAudience: string
  readonly groupId: string
  readonly deliveryId: string
  readonly botId: string
  readonly memberCycle: number
  readonly messageSeq: number
  readonly text: string
}
export interface BotGroupStopTicketExpected extends Omit<BotGroupTicketExpected, 'text'> {
  readonly payloadDigest: string
  readonly requestId: string
}
export type BotGroupResultTicketExpected = BotGroupTicketExpected
export interface BotGroupTicket {
  readonly ownerUserId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly messageId: string
  readonly payloadDigest: string
  readonly expiresAt: number
}
interface AcceptedClaims {
  owner_user_id: string
  issued_at: number
  expires_at: number
  workspace_id: string
  session_id: string
  message_id: string
  payload_digest: string
}
const fail = (): never => { throw Error('bot_group_ticket_invalid') }
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
export function issuerOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password &&
      !url.search && !url.hash ? url.origin : null
  } catch { return null }
}
export function decoded(value: string): unknown {
  if (!SEGMENT.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) fail()
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) }
  catch { return fail() }
}
function publicKeys(keyring: BotGroupPublicKeyring): Map<string, VerifiedKey> {
  if (!UUID.test(keyring.environmentId) ||
      !issuerOrigin(keyring.issuer) ||
      !Array.isArray(keyring.keys) || keyring.keys.length < 1 || keyring.keys.length > 4) fail()
  const keys = new Map<string, VerifiedKey>()
  for (const entry of keyring.keys) {
    if (typeof entry.kid !== 'string' || !/^dsh-assertion-[A-Za-z0-9][A-Za-z0-9._:-]{0,84}$/u.test(entry.kid) ||
        keys.has(entry.kid) || !positive(entry.validFrom) || !positive(entry.validUntil) ||
        entry.validUntil <= entry.validFrom) fail()
    const key = createPublicKey(entry.publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519') fail()
    keys.set(entry.kid, { key, validFrom: entry.validFrom, validUntil: entry.validUntil })
  }
  return keys
}

/** Derive the exact Host registry from the verified Account binding and installation. */
export function botGroupHostRegistryId(input: { readonly ownerUserId: string } & Pick<BotGroupTicketExpected,
  'accountIssuer' | 'accountSubject' | 'environmentId' |
  'installationId' | 'accountBindingHandle' | 'accountBindingEpoch'>): string {
  const coordinates = JSON.stringify([input.ownerUserId, input.accountIssuer,
    input.accountSubject, input.environmentId, input.installationId,
    input.accountBindingHandle, String(input.accountBindingEpoch)])
  return 'h2_' + createHash('sha256').update('registry\0' + coordinates).digest('hex')
}

/** Only a pinned Slark environment key and current Account tuple authorize the payload. */
function verifySignedBotGroupTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupTicketExpected | BotGroupStopTicketExpected,
  kind: 'delivery' | 'stop' | 'result', now: number): BotGroupTicket {
  if (typeof token !== 'string' || Buffer.byteLength(token) > 8192) fail()
  const pieces = token.split('.')
  if (pieces.length !== 3) fail()
  try {
    const [headerPart, claimsPart, signaturePart] = pieces as [string, string, string]
    const headerValue = decoded(headerPart)
    const claimsValue = decoded(claimsPart)
    if (!exact(headerValue, ['alg', 'typ', 'version', 'kid']) ||
        !exact(claimsValue, kind === 'stop' ? STOP_CLAIMS :
          kind === 'result' ? RESULT_CLAIMS : CLAIMS)) fail()
    const header = headerValue as Record<string, unknown>
    const claims = claimsValue as Record<string, unknown>
    if (header.alg !== 'EdDSA' ||
        header.typ !== (kind === 'stop' ? 'SLARK-DSH-BOT-GROUP-STOP' :
          kind === 'result' ? 'SLARK-DSH-BOT-GROUP-RESULT' :
            'SLARK-DSH-BOT-GROUP') || header.version !== 1 ||
        typeof header.kid !== 'string' ||
        claims.schema_version !== 1 || claims.issuer !== keyring.issuer ||
        issuerOrigin(keyring.issuer) !== expected.slarkAudience ||
        claims.audience !== (kind === 'stop' ? STOP_AUDIENCE :
          kind === 'result' ? RESULT_AUDIENCE : AUDIENCE) ||
        claims.slark_audience !== expected.slarkAudience ||
        claims.environment_id !== expected.environmentId ||
        claims.environment_id !== keyring.environmentId ||
        typeof claims.owner_user_id !== 'string' || !SLARK_USER.test(claims.owner_user_id) ||
        claims.computer_id !== expected.computerId ||
        claims.account_issuer !== expected.accountIssuer ||
        claims.account_subject !== expected.accountSubject ||
        claims.account_binding_epoch !== expected.accountBindingEpoch ||
        claims.host_registry_id !== botGroupHostRegistryId({ ...expected,
          ownerUserId: claims.owner_user_id }) ||
        typeof claims.host_registry_id !== 'string' || !REGISTRY.test(claims.host_registry_id) ||
        claims.group_id !== expected.groupId || claims.delivery_id !== expected.deliveryId ||
        claims.bot_id !== expected.botId || claims.member_cycle !== expected.memberCycle ||
        claims.message_seq !== expected.messageSeq ||
        typeof claims.workspace_id !== 'string' || !UUID.test(claims.workspace_id) ||
        typeof claims.session_id !== 'string' || !/^[\x21-\x7e]{1,256}$/u.test(claims.session_id) ||
        /[/\\]/u.test(claims.session_id) || claims.session_id === '.' || claims.session_id === '..' ||
        typeof claims.message_id !== 'string' || !UUID.test(claims.message_id) ||
        typeof claims.payload_digest !== 'string' || !DIGEST.test(claims.payload_digest) ||
        typeof claims.token_id !== 'string' || !UUID.test(claims.token_id) ||
        !positive(claims.issued_at) || !positive(claims.expires_at) ||
        claims.issued_at > now + 5000 || claims.expires_at <= now ||
        claims.expires_at <= claims.issued_at || claims.expires_at - claims.issued_at > 60_000 ||
        typeof claims.slark_audience !== 'string' || !UUID.test(expected.groupId) ||
        !UUID.test(expected.deliveryId) || !BOT.test(expected.botId) ||
        !positive(expected.memberCycle) || !positive(expected.messageSeq)) fail()
    if (kind === 'stop') {
      const stop = expected as BotGroupStopTicketExpected
      if (typeof stop.requestId !== 'string' || !UUID.test(stop.requestId) ||
          claims.decision_request_id !== stop.requestId ||
          typeof stop.payloadDigest !== 'string' || !DIGEST.test(stop.payloadDigest) ||
          claims.payload_digest !== stop.payloadDigest) fail()
    } else {
      const delivery = expected as BotGroupTicketExpected
      const digest = createHash('sha256').update(JSON.stringify(['slark_bot_group_v1',
        claims.message_id, claims.group_id, `deepseek-bot:${expected.botId}`,
        expected.memberCycle, expected.messageSeq, delivery.text])).digest('hex')
      if (claims.payload_digest !== digest) fail()
      if (kind === 'result') {
        if (claims.decision_request_id !== null &&
            (typeof claims.decision_request_id !== 'string' ||
              !UUID.test(claims.decision_request_id))) fail()
      }
    }
    const accepted: AcceptedClaims = {
      owner_user_id: claims.owner_user_id as string,
      issued_at: claims.issued_at as number, expires_at: claims.expires_at as number,
      workspace_id: claims.workspace_id as string, session_id: claims.session_id as string,
      message_id: claims.message_id as string, payload_digest: claims.payload_digest as string,
    }
    const key = publicKeys(keyring).get(header.kid as string)
    const signature = Buffer.from(signaturePart, 'base64url')
    if (!key || key.validFrom > accepted.issued_at || key.validUntil < accepted.expires_at ||
        signature.length !== 64 || signature.toString('base64url') !== signaturePart ||
        !verify(null, Buffer.from(`${headerPart}.${claimsPart}`, 'ascii'), key.key, signature)) fail()
    return { ownerUserId: accepted.owner_user_id,
      workspaceId: accepted.workspace_id, sessionId: accepted.session_id,
      messageId: accepted.message_id, payloadDigest: accepted.payload_digest,
      expiresAt: accepted.expires_at }
  } catch { return fail() }
}

export function verifyBotGroupTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupTicketExpected, now = Date.now()): BotGroupTicket {
  return verifySignedBotGroupTicket(token, keyring, expected, 'delivery', now)
}

/** Stop authority is separate from delivery authority and bound to one owner decision. */
export function verifyBotGroupStopTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupStopTicketExpected, now = Date.now()): BotGroupTicket {
  return verifySignedBotGroupTicket(token, keyring, expected, 'stop', now)
}

/** A result ticket permits observation and acknowledgement, never a new delivery. */
export function verifyBotGroupResultTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupResultTicketExpected, now = Date.now()): BotGroupTicket {
  return verifySignedBotGroupTicket(token, keyring, expected, 'result', now)
}

/** Recheck live Slark membership at the pinned origin before the worker accepts a delivery. */
export async function confirmBotGroupTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupTicketExpected, signal: AbortSignal,
  fetchFn: typeof fetch = fetch, clock: () => number = Date.now): Promise<BotGroupTicket> {
  const ticket = verifyBotGroupTicket(token, keyring, expected, clock())
  const { value, bounded } = await onlineConfirmation(token, expected.slarkAudience,
    'delivery-confirm', signal, fetchFn)
  if (!exact(value, ['state', 'delivery_id', 'expires_at']) ||
      value.state !== 'active' || value.delivery_id !== expected.deliveryId ||
      value.expires_at !== ticket.expiresAt || bounded.aborted ||
      clock() >= ticket.expiresAt) fail()
  return ticket
}

/** A stop reaches the worker only while Slark still recognizes the exact owner decision. */
export async function confirmBotGroupStopTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupStopTicketExpected, signal: AbortSignal,
  fetchFn: typeof fetch = fetch, clock: () => number = Date.now): Promise<BotGroupTicket> {
  const ticket = verifyBotGroupStopTicket(token, keyring, expected, clock())
  const { value, bounded } = await onlineConfirmation(token, expected.slarkAudience,
    'stop-confirm', signal, fetchFn)
  if (!exact(value, ['state', 'delivery_id', 'decision_request_id', 'expires_at']) ||
      value.state !== 'authorized' || value.delivery_id !== expected.deliveryId ||
      value.decision_request_id !== expected.requestId ||
      value.expires_at !== ticket.expiresAt || bounded.aborted ||
      clock() >= ticket.expiresAt) fail()
  return ticket
}

async function confirmResultTicketFor(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupResultTicketExpected, signal: AbortSignal,
  operation: 'result-confirm' | 'result-ack-confirm',
  fetchFn: typeof fetch, clock: () => number): Promise<BotGroupTicket> {
  const ticket = verifyBotGroupResultTicket(token, keyring, expected, clock())
  const { value, bounded } = await onlineConfirmation(token, expected.slarkAudience,
    operation, signal, fetchFn)
  if (!exact(value, ['state', 'delivery_id', 'expires_at']) ||
      value.state !== 'authorized' || value.delivery_id !== expected.deliveryId ||
      value.expires_at !== ticket.expiresAt || bounded.aborted ||
      clock() >= ticket.expiresAt) fail()
  return ticket
}

/** Result observation remains bound to the current Slark owner and original delivery. */
export async function confirmBotGroupResultTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupResultTicketExpected, signal: AbortSignal,
  fetchFn: typeof fetch = fetch, clock: () => number = Date.now): Promise<BotGroupTicket> {
  return confirmResultTicketFor(token, keyring, expected, signal, 'result-confirm', fetchFn, clock)
}

/** Result acknowledgement additionally requires Slark to have recorded the exact result. */
export async function confirmBotGroupResultAckTicket(token: string, keyring: BotGroupPublicKeyring,
  expected: BotGroupResultTicketExpected, signal: AbortSignal,
  fetchFn: typeof fetch = fetch, clock: () => number = Date.now): Promise<BotGroupTicket> {
  return confirmResultTicketFor(token, keyring, expected, signal, 'result-ack-confirm', fetchFn, clock)
}

async function onlineConfirmation(token: string, slarkAudience: string,
  operation: 'delivery-confirm' | 'stop-confirm' | 'result-confirm' |
    'result-ack-confirm', signal: AbortSignal,
  fetchFn: typeof fetch): Promise<{ value: unknown; bounded: AbortSignal }> {
  if (signal.aborted) fail()
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5_000)])
  try {
    const response = await fetchFn(slarkAudience +
      '/api/v1/dsh/collaboration-v2/group-messages/' + operation, {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, 'cache-control': 'no-store' }, signal: bounded,
    })
    const bodyStream = response.body
    if (response.status !== 200 || !bodyStream) throw Error('bot_group_ticket_invalid')
    const reader = bodyStream.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 4_096) { await reader.cancel(); fail() }
      chunks.push(next.value)
    }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(chunks)))
    if (!exact(body, ['ok', 'value']) || body.ok !== true) fail()
    return { value: (body as Record<string, unknown>).value, bounded }
  } catch { return fail() }
}
