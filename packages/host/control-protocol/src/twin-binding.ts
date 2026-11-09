/** REQ-20261031-0006 / Task26151: purpose-bound confirmation and durable acknowledgement. */
import { createHash } from 'node:crypto'
import { record, text, uuid, digest, id, version, time } from './twin-binding-validation.ts'
import { parseHostTwinBindingOffer, hostTwinBindingOfferDigest, hostTwinBindingCommandDigest,
  type HostTwinBindingOffer } from './twin-binding-offer.ts'

/** The public installation selected by current authenticated transport, never a request-selected key. */
export type HostTwinBindingPeer = Readonly<{
  installationId: string
  publicKey: string
  hostInstanceId: string
  processNonce: string
}>
/** Short Cloud authority for one exact original confirmation or read-only receipt recovery. */
export type HostTwinBindingDirective = Readonly<{
  schemaVersion: 1
  purpose: 'twin_binding_confirm' | 'twin_binding_receipt'
  issuer: string
  keyId: string
  authorityEnvironmentId: string
  ownerUserId: string
  accountIssuer: string
  accountSubject: string
  accountBindingId: string
  accountBindingVersion: number
  computerId: string
  peer: HostTwinBindingPeer
  requestId: string
  bindingId: string
  bindingGeneration: string
  scopeVersion: string
  scopeDigest: string
  payloadDigest: string
  issuedAt: number
  expiresAt: number
  signature: string
}>
/** A receipt request cannot submit a new offer or change the original command. */
export type HostTwinBindingCommand =
  | Readonly<{ operation: 'confirm'; requestId: string; offer: HostTwinBindingOffer }>
  | Readonly<{ operation: 'receipt'
    requestId: string
    bindingId: string
    bindingGeneration: string
    scopeDigest: string
    payloadDigest: string }>
/** Both sides consume the same strictly bounded request body. */
export type HostTwinBindingInput = Readonly<{
  directive: HostTwinBindingDirective
  command: HostTwinBindingCommand
}>
/** Acknowledges persisted owner consent only; active binding and execution remain Cloud decisions. */
export type HostTwinBindingAck = Readonly<{
  schemaVersion: 1
  purpose: 'twin_binding_acknowledged'
  authorityEnvironmentId: string
  ownerUserId: string
  accountIssuer: string
  accountSubject: string
  accountBindingId: string
  accountBindingVersion: number
  hostProfileId: string
  botId: string
  requestId: string
  bindingId: string
  bindingGeneration: string
  scopeVersion: string
  scopeDigest: string
  payloadDigest: string
  peer: HostTwinBindingPeer
  durableAt: number
  signature: string
}>
/** Absence is meaningful only for a read-only, currently authorized recovery request. */
export type HostTwinBindingResult = Readonly<{ state: 'acknowledged'; ack: HostTwinBindingAck }>
  | Readonly<{ state: 'missing' }>

const peerKeys = ['installationId', 'publicKey', 'hostInstanceId', 'processNonce']
const directiveKeys = ['schemaVersion', 'purpose', 'issuer', 'keyId', 'authorityEnvironmentId',
  'ownerUserId', 'accountIssuer', 'accountSubject', 'accountBindingId', 'accountBindingVersion',
  'computerId', 'peer', 'requestId', 'bindingId', 'bindingGeneration', 'scopeVersion', 'scopeDigest',
  'payloadDigest', 'issuedAt', 'expiresAt', 'signature']
const ackKeys = ['schemaVersion', 'purpose', 'authorityEnvironmentId', 'ownerUserId', 'accountIssuer',
  'accountSubject', 'accountBindingId', 'accountBindingVersion', 'hostProfileId', 'botId', 'requestId',
  'bindingId', 'bindingGeneration', 'scopeVersion', 'scopeDigest', 'payloadDigest', 'peer', 'durableAt', 'signature']
function canonicalBase64(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || value.length !== Math.ceil(bytes * 8 / 6))
    throw Error('invalid_twin_binding_request')
  const s = text(value, /^[A-Za-z0-9_-]+$/u), b = Buffer.from(s, 'base64url')
  if (b.length !== bytes || b.toString('base64url') !== s) throw Error('invalid_twin_binding_request')
  return s
}
function positive(value: unknown): number {
  const n = time(value)
  if (n < 1) throw Error('invalid_twin_binding_request')
  return n
}
function accountIssuer(value: unknown): string {
  if (value !== 'https://accounts.dsh.colorbuyai.com'
   && value !== 'https://accounts.staging.dsh.colorbuyai.com') throw Error('invalid_twin_binding_request')
  return value
}
function peer(value: unknown): HostTwinBindingPeer {
  const x = record(value, peerKeys)
  return { installationId: uuid(x.installationId), publicKey: canonicalBase64(x.publicKey, 32),
    hostInstanceId: uuid(x.hostInstanceId), processNonce: canonicalBase64(x.processNonce, 32) }
}
function issuer(value: unknown): string {
  const s = text(value, /^https:\/\/[!-~]{1,2040}$/u)
  const url = new URL(s)
  if (url.origin !== s) throw Error('invalid_twin_binding_request')
  return s
}
const invalid = (): never => { throw Error('invalid_twin_binding_request') }

/**
 * Canonical fields; signature and current time are checked by the executor.
 * @param value - Untrusted directive.
 * @returns Canonical fields; signature and current time are checked by the executor.
 */
export function parseHostTwinBindingDirective(value: unknown): HostTwinBindingDirective {
  try {
    const x = record(value, directiveKeys)
    if (x.schemaVersion !== 1 || (x.purpose !== 'twin_binding_confirm' && x.purpose !== 'twin_binding_receipt'))
      return invalid()
    const d: HostTwinBindingDirective = { schemaVersion: 1, purpose: x.purpose, issuer: issuer(x.issuer),
      keyId: text(x.keyId, /^dsh-assertion-[A-Za-z0-9][A-Za-z0-9._:-]{0,84}$/u),
      authorityEnvironmentId: uuid(x.authorityEnvironmentId), ownerUserId: id(x.ownerUserId),
      accountIssuer: accountIssuer(x.accountIssuer), accountSubject: uuid(x.accountSubject),
      accountBindingId: id(x.accountBindingId), accountBindingVersion: positive(x.accountBindingVersion),
      computerId: id(x.computerId), peer: peer(x.peer), requestId: uuid(x.requestId),
      bindingId: uuid(x.bindingId), bindingGeneration: version(x.bindingGeneration), scopeVersion: version(x.scopeVersion),
      scopeDigest: digest(x.scopeDigest), payloadDigest: digest(x.payloadDigest),
      issuedAt: time(x.issuedAt), expiresAt: time(x.expiresAt), signature: canonicalBase64(x.signature, 64) }
    if (d.expiresAt <= d.issuedAt || d.expiresAt - d.issuedAt > 30000) return invalid()
    return d
  } catch { return invalid() }
}
function fields(value: HostTwinBindingDirective | HostTwinBindingAck, keys: readonly string[]): unknown[] {
  return keys.filter(key => key !== 'signature').map(key => key === 'peer'
    ? peerKeys.map(name => value.peer[name as keyof HostTwinBindingPeer]) : value[key as keyof typeof value])
}
/**
 * Domain and canonical array, excluding signature itself.
 * @param value - Exact directive.
 * @returns Domain and canonical array, excluding signature itself.
 */
export function encodeHostTwinBindingDirective(value: HostTwinBindingDirective): string {
  return 'slark.twin-binding-directive/v1\0' + JSON.stringify(fields(parseHostTwinBindingDirective(value), directiveKeys))
}
/**
 * Detached fields with all direction, consent and payload digests checked.
 * @param value - Untrusted full command.
 * @returns Detached fields with all direction, consent and payload digests checked.
 */
export function parseHostTwinBindingInput(value: unknown): HostTwinBindingInput {
  try {
    const x = record(value, ['directive', 'command']), directive = parseHostTwinBindingDirective(x.directive)
    const raw = record(x.command, directive.purpose === 'twin_binding_confirm'
      ? ['operation', 'requestId', 'offer']
      : ['operation', 'requestId', 'bindingId', 'bindingGeneration', 'scopeDigest', 'payloadDigest'])
    const requestId = uuid(raw.requestId)
    let command: HostTwinBindingCommand
    if (directive.purpose === 'twin_binding_confirm') {
      const offer = parseHostTwinBindingOffer(raw.offer, directive)
      if (raw.operation !== 'confirm' || offer.bindingId !== directive.bindingId
       || offer.bindingGeneration !== directive.bindingGeneration || offer.scopeVersion !== directive.scopeVersion
       || hostTwinBindingOfferDigest(offer) !== directive.scopeDigest
       || hostTwinBindingCommandDigest(requestId, offer) !== directive.payloadDigest) return invalid()
      command = { operation: 'confirm', requestId, offer }
    } else {
      if (raw.operation !== 'receipt' || raw.bindingId !== directive.bindingId
       || raw.bindingGeneration !== directive.bindingGeneration || raw.scopeDigest !== directive.scopeDigest
       || raw.payloadDigest !== directive.payloadDigest) return invalid()
      command = { operation: 'receipt', requestId, bindingId: directive.bindingId,
        bindingGeneration: directive.bindingGeneration, scopeDigest: directive.scopeDigest, payloadDigest: directive.payloadDigest }
    }
    if (requestId !== directive.requestId || Buffer.byteLength(JSON.stringify(command)) > 32768
     || Buffer.byteLength(JSON.stringify(directive)) > 8192) return invalid()
    return { directive, command }
  } catch { return invalid() }
}
/**
 * Strict original fact, not current execution permission.
 * @param value - Persisted or remote acknowledgement.
 * @returns Strict original fact, not current execution permission.
 */
export function parseHostTwinBindingAck(value: unknown): HostTwinBindingAck {
  try {
    const x = record(value, ackKeys)
    if (x.schemaVersion !== 1 || x.purpose !== 'twin_binding_acknowledged') return invalid()
    return { schemaVersion: 1, purpose: 'twin_binding_acknowledged',
      authorityEnvironmentId: uuid(x.authorityEnvironmentId), ownerUserId: id(x.ownerUserId),
      accountIssuer: accountIssuer(x.accountIssuer), accountSubject: uuid(x.accountSubject),
      accountBindingId: id(x.accountBindingId), accountBindingVersion: positive(x.accountBindingVersion),
      hostProfileId: uuid(x.hostProfileId), botId: text(x.botId, /^[A-Za-z0-9_-]{1,200}$/u),
      requestId: uuid(x.requestId), bindingId: uuid(x.bindingId), bindingGeneration: version(x.bindingGeneration),
      scopeVersion: version(x.scopeVersion), scopeDigest: digest(x.scopeDigest), payloadDigest: digest(x.payloadDigest),
      peer: peer(x.peer), durableAt: time(x.durableAt), signature: canonicalBase64(x.signature, 64) }
  } catch { return invalid() }
}
/**
 * Stable signing bytes excluding signature.
 * @param value - Exact acknowledgement.
 * @returns Stable signing bytes excluding signature.
 */
export function encodeHostTwinBindingAck(value: HostTwinBindingAck): string {
  return 'dsh.twin-binding-confirmation-ack/v1\0' + JSON.stringify(fields(parseHostTwinBindingAck(value), ackKeys))
}
/**
 * Persistent digest that includes its original signature.
 * @param value - Original signed fact.
 * @returns Persistent digest that includes its original signature.
 */
export function hostTwinBindingAckDigest(value: HostTwinBindingAck): string {
  const ack = parseHostTwinBindingAck(value)
  return createHash('sha256').update('dsh.twin-binding-confirmation-ack-digest/v1\0'
   + JSON.stringify([fields(ack, ackKeys), ack.signature])).digest('hex')
}
/**
 * Only durable acknowledgement or explicit receipt absence.
 * @param value - Untrusted Host response.
 * @returns Only durable acknowledgement or explicit receipt absence.
 */
export function parseHostTwinBindingResult(value: unknown): HostTwinBindingResult {
  try {
    if (value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'state')?.value === 'missing') {
      record(value, ['state'])
      return { state: 'missing' }
    }
    const x = record(value, ['state', 'ack'])
    if (x.state !== 'acknowledged') return invalid()
    return { state: 'acknowledged', ack: parseHostTwinBindingAck(x.ack) }
  } catch { return invalid() }
}
