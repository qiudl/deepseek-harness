/** REQ-20261023-0001: source Host E2EE key assertion bound to one target assertion. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const COMPUTER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const B64 = /^[A-Za-z0-9_-]+$/u
const invalid = (): never => { throw Error('invalid_bot_import_relay_source_key') }
const row = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Reflect.ownKeys(value).length === keys.length && keys.every(key =>
    Object.getOwnPropertyDescriptor(value, key)?.value !== undefined)
const encoded = (value: unknown, length: number): value is string =>
  typeof value === 'string' && B64.test(value) &&
  Buffer.from(value, 'base64url').length === length &&
  Buffer.from(value, 'base64url').toString('base64url') === value

/** Fields supplied by the trusted Main broker; Host checks the live Account Profile. */
export interface HostBotImportSourceRelayKeyRequest {
  readonly sourceComputerId: string
  readonly sourceProfileId: string
  readonly environmentId: string
  readonly accountIssuer: string
  readonly accountSubject: string
  readonly accountBindingHandle: string
  readonly authGeneration: number
  readonly importOperationId: string
  readonly sourceDigest: string
  readonly targetAssertionDigest: string
  readonly ephemeralPublicKey: string
}

/** Host-signed source key and the current Account/installation coordinates. */
export interface HostBotImportSourceRelayKeyAssertion extends HostBotImportSourceRelayKeyRequest {
  readonly version: 1
  readonly installationId: string
  readonly installationPublicKey: string
  readonly hostInstanceId: string
  readonly processNonce: string
  readonly nonce: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly signature: string
}

/** Parse an untrusted source-key signing request without accepting extra fields.
 * @param value - Untrusted wire value.
 * @returns The exact request fields.
 */
export function parseHostBotImportSourceRelayKeyRequest(value: unknown): HostBotImportSourceRelayKeyRequest {
  if (!row(value)) throw Error('invalid_bot_import_relay_source_key')
  if (!exact(value, ['sourceComputerId', 'sourceProfileId',
    'environmentId', 'accountIssuer', 'accountSubject', 'accountBindingHandle',
    'authGeneration', 'importOperationId', 'sourceDigest', 'targetAssertionDigest',
    'ephemeralPublicKey']) ||
    typeof value.sourceComputerId !== 'string' || !COMPUTER.test(value.sourceComputerId) ||
    typeof value.sourceProfileId !== 'string' || !UUID.test(value.sourceProfileId) ||
    typeof value.environmentId !== 'string' || !UUID.test(value.environmentId) ||
    typeof value.accountIssuer !== 'string' || !/^https:\/\/[^\s/]+$/u.test(value.accountIssuer) ||
    typeof value.accountSubject !== 'string' || !UUID.test(value.accountSubject) ||
    typeof value.accountBindingHandle !== 'string' ||
    !/^[\x21-\x7e]{1,256}$/u.test(value.accountBindingHandle) ||
    !Number.isSafeInteger(value.authGeneration) || (value.authGeneration as number) < 1 ||
    typeof value.importOperationId !== 'string' || !UUID.test(value.importOperationId) ||
    typeof value.sourceDigest !== 'string' || !SHA256.test(value.sourceDigest) ||
    typeof value.targetAssertionDigest !== 'string' || !SHA256.test(value.targetAssertionDigest) ||
    !encoded(value.ephemeralPublicKey, 65) ||
    Buffer.from(value.ephemeralPublicKey, 'base64url')[0] !== 4) invalid()
  return {
    sourceComputerId: value.sourceComputerId as string,
    sourceProfileId: value.sourceProfileId as string,
    environmentId: value.environmentId as string,
    accountIssuer: value.accountIssuer as string,
    accountSubject: value.accountSubject as string,
    accountBindingHandle: value.accountBindingHandle as string,
    authGeneration: value.authGeneration as number,
    importOperationId: value.importOperationId as string,
    sourceDigest: value.sourceDigest as string,
    targetAssertionDigest: value.targetAssertionDigest as string,
    ephemeralPublicKey: value.ephemeralPublicKey as string,
  }
}

/** Parse all signed fields and enforce the five-minute lifetime.
 * @param value - Untrusted wire value.
 * @returns The signed source-key fields.
 */
export function parseHostBotImportSourceRelayKeyAssertion(value: unknown): HostBotImportSourceRelayKeyAssertion {
  if (!row(value)) throw Error('invalid_bot_import_relay_source_key')
  if (!exact(value, ['version', 'installationId',
    'installationPublicKey', 'hostInstanceId', 'processNonce',
    'sourceComputerId', 'sourceProfileId', 'environmentId', 'accountIssuer',
    'accountSubject', 'accountBindingHandle', 'authGeneration', 'importOperationId',
    'sourceDigest', 'targetAssertionDigest', 'ephemeralPublicKey', 'nonce',
    'issuedAt', 'expiresAt', 'signature']) || value.version !== 1 ||
    typeof value.installationId !== 'string' || !UUID.test(value.installationId) ||
    !encoded(value.installationPublicKey, 32) ||
    typeof value.hostInstanceId !== 'string' || !UUID.test(value.hostInstanceId) ||
    !encoded(value.processNonce, 32) || !encoded(value.nonce, 32) ||
    !encoded(value.signature, 64) || !Number.isSafeInteger(value.issuedAt) ||
    (value.issuedAt as number) < 1 || !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= (value.issuedAt as number) ||
    (value.expiresAt as number) - (value.issuedAt as number) > 300_000) invalid()
  const request = parseHostBotImportSourceRelayKeyRequest({
    sourceComputerId: value.sourceComputerId, sourceProfileId: value.sourceProfileId,
    environmentId: value.environmentId, accountIssuer: value.accountIssuer,
    accountSubject: value.accountSubject, accountBindingHandle: value.accountBindingHandle,
    authGeneration: value.authGeneration, importOperationId: value.importOperationId,
    sourceDigest: value.sourceDigest, targetAssertionDigest: value.targetAssertionDigest,
    ephemeralPublicKey: value.ephemeralPublicKey,
  })
  return { version: 1, installationId: value.installationId as string,
    installationPublicKey: value.installationPublicKey as string,
    hostInstanceId: value.hostInstanceId as string,
    processNonce: value.processNonce as string, ...request,
    nonce: value.nonce as string, issuedAt: value.issuedAt as number,
    expiresAt: value.expiresAt as number, signature: value.signature as string }
}

/** Encode the exact signature transcript shared with Slark's verifier.
 * @param value - Valid source-key claims.
 * @returns Canonical bytes.
 */
export function encodeHostBotImportSourceRelayKeyPayload(
  value: Omit<HostBotImportSourceRelayKeyAssertion, 'signature'>,
): Buffer {
  const assertion = parseHostBotImportSourceRelayKeyAssertion({ ...value,
    signature: Buffer.alloc(64).toString('base64url') })
  const fields = [assertion.version, assertion.installationId,
    assertion.installationPublicKey, assertion.hostInstanceId,
    assertion.processNonce, assertion.sourceComputerId, assertion.sourceProfileId,
    assertion.environmentId, assertion.accountIssuer, assertion.accountSubject,
    assertion.accountBindingHandle, assertion.authGeneration, assertion.importOperationId,
    assertion.sourceDigest, assertion.targetAssertionDigest,
    assertion.ephemeralPublicKey, assertion.nonce, assertion.issuedAt,
    assertion.expiresAt]
  return Buffer.from(`dsh-bot-import-relay-source-key/v1\0${JSON.stringify(fields)}`, 'utf8')
}
