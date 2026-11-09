import type { ProjectOperationMemorySourceExports } from './project-operation-memory-source-exports.ts'
import { projectOperationMemoryEventsDigest } from './project-operation-memory-metadata.ts'
/** Account-authorized private memory source publication; Root admission is not an export permission. */
import { verify, createHash } from 'node:crypto'
import {
  encodeHostProjectMemoryDirective,
  parseHostProjectMemoryRequest,
  parseHostProjectMemorySourceProof,
  encodeHostProjectMemorySourceProof,
  hostProjectMemoryDirectiveDigest,
  hostProjectMemoryReadResultDigest,
  parseHostProjectMemoryReadResult,
  parseHostProjectMemoryReadEnvelope,
  parseHostProjectMemoryCheckpoint,
  parseHostProjectMemoryResponse,
  parseHostProjectMemoryJson,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  HostProjectMemoryEnvironment,
  HostProjectMemoryDirective,
  HostRemoteSessionJson,
  HostProjectMemoryPeer,
  HostProjectMemoryCommands,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import type { DesktopHost } from './desktop-host.ts'
import type { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
import { HostAuthorityError } from './types.ts'

const codes = new Set([
  'unauthorized',
  'binding_inactive',
  'scope_changed',
  'source_changed',
  'material_revoked',
  'journal_epoch_changed',
  'cursor_invalid',
  'cursor_expired',
  'capability_unavailable',
  'payload_too_large',
  'conflict',
  'timeout',
])
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some(k => !Object.hasOwn(value, k))
  )
    throw new HostAuthorityError('unavailable')
  return value as Record<string, unknown>
}
function code(error: unknown): string {
  const value: unknown =
    error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
  if (typeof value === 'string' && codes.has(value)) return value
  return value === 'idempotency_conflict'
    ? 'conflict'
    : value === 'stale'
      ? 'timeout'
      : value === 'profile_mismatch'
        ? 'unauthorized'
        : 'capability_unavailable'
}
/** Exact private environment/Account/current-worker authority held by the Host, never a renderer or model. */
export interface AccountProjectOperationMemoryOptions {
  readonly host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>
  readonly peer: Pick<HostProjectMemoryPeer, 'installationId' | 'publicKey' | 'hostInstanceId' | 'processNonce'>
  readonly environments: readonly HostProjectMemoryEnvironment[]
  readonly sourceExports?: (
    profileId: string,
  ) => ProjectOperationMemorySourceExports | Promise<ProjectOperationMemorySourceExports>
  readonly metadata: (profileId: string) => ProjectOperationMemoryMetadata | Promise<ProjectOperationMemoryMetadata>
  readonly execute: (
    profileId: string,
    command: HostRemoteSessionJson,
    signal: AbortSignal,
  ) => Promise<HostRemoteSessionJson>
  readonly sign: (payload: Buffer) => string
  readonly now: () => number
}
/** Verify the exact configured memory purpose and Cloud key before any source call.
 * @param environments - Signed embedding policies.
 * @param directive - Strict parsed candidate permission.
 * @param now - Actual admission/publication clock.
 * @returns Nothing; unrelated purposes, environments, intervals and signatures reject.
 */
export function verifyProjectOperationMemoryDirective(
  environments: readonly HostProjectMemoryEnvironment[],
  directive: HostProjectMemoryDirective,
  now: number,
): void {
  const d = directive,
    policy = environments.find(
      e => e.keyring.environmentId === d.authorityEnvironmentId && e.keyring.issuer === d.issuer,
    )
  if (!policy) throw new HostAuthorityError('unavailable')
  const key = policy.keyring.keys.find(k => k.kid === d.keyId)
  if (
    !key ||
    d.audience !== policy.audience ||
    d.environmentKey !== policy.environmentKey ||
    !Number.isSafeInteger(now) ||
    now < d.issuedAt ||
    now >= d.expiresAt ||
    d.issuedAt < key.validFrom ||
    d.expiresAt > key.validUntil ||
    !verify(
      null,
      Buffer.from(encodeHostProjectMemoryDirective(d)),
      key.publicKeyPem,
      Buffer.from(d.signature, 'base64url'),
    )
  )
    throw new HostAuthorityError('unauthorized')
}
/** Execute a signed source-only read and sign its bounded actual metadata after the final Account fence.
 * @param options - Host-owned fixed keys, installation signer, actual worker and durable metadata stores.
 * @param account - Current authenticated Main connection's exact Account.
 * @param value - Frozen request without caller-selected local identity, mode or token.
 * @param bindingKey - Parent-generated current request binding, independent of source export authority.
 * @param signal - Connection cancellation.
 * @returns Closed read or durable source-export result; retained paths remain explicitly unavailable.
 */
export async function operateAccountProjectOperationMemory(
  options: AccountProjectOperationMemoryOptions,
  account: BotIdentityAccount,
  value: unknown,
  bindingKey: string,
  signal: AbortSignal,
): Promise<HostRemoteSessionJson> {
  const request = parseHostProjectMemoryRequest(value),
    d = request.directive
  const authorize = () => {
    signal.throwIfAborted()
    options.host.authorizeCollaborationRegistration(account)
    return options.host.authorizeAccountModelText(account)
  }
  const profileId = authorize()
  const guard = () => {
    if (authorize() !== profileId) throw new HostAuthorityError('profile_mismatch')
    verifyProjectOperationMemoryDirective(options.environments, d, options.now())
  }
  try {
    if (
      d.authorityEnvironmentId !== account.authorityEnvironmentId ||
      d.accountIssuer !== account.issuer ||
      d.accountSubject !== account.subject ||
      d.accountBindingId !== account.accountBindingHandle ||
      d.accountBindingVersion !== account.authorityBindingVersion ||
      !d.peer ||
      ['installationId', 'publicKey', 'hostInstanceId', 'processNonce'].some(
        k => Reflect.get(d.peer as object, k) !== Reflect.get(options.peer, k),
      )
    )
      throw new HostAuthorityError('unauthorized')
    guard()
    if (d.direction !== 'dsh_to_slark' || d.scope.sourceRef.side !== 'dsh')
      return parseHostProjectMemoryJson({
        status: 'error',
        code: 'capability_unavailable',
        requestId: d.requestId,
        retryable: false,
      })
    if (
      d.scope.sourceRef.hostProfileId !== profileId ||
      !d.scope.sourceRef.botRootId ||
      d.scope.sourceRef.actorRef !== 'deepseek-bot:' + d.scope.sourceRef.botRootId ||
      d.scope.sourceRef.providerId !== 'dsh-project-operation-v1' ||
      d.scope.sourceRef.providerVersion !== '1'
    )
      throw new HostAuthorityError('unauthorized')
    const store = await options.metadata(profileId)
    guard()
    store.reserveNonce([d.authorityEnvironmentId, d.issuer, d.keyId, d.nonce], options.now(), d.expiresAt, guard)
    if (d.operation === 'apply' || d.operation === 'receipt') {
      const exports = await options.sourceExports?.(profileId)
      guard()
      if (!exports) throw new HostAuthorityError('unavailable')
      guard()
      const result =
        d.operation === 'receipt'
          ? exports.read(d, request.commandBody as HostProjectMemoryCommands['receipt'])
          : (() => {
            const command = request.commandBody as HostProjectMemoryCommands['apply']
            return command.phase === 'stage'
              ? exports.stage(d, command, store, options.now(), options.sign, guard)
              : exports.finalize(d, command, options.now(), guard, options.sign)
          })()
      guard()
      return parseHostProjectMemoryJson(parseHostProjectMemoryResponse(result))
    }
    const original = store.find(d.scope, d.ownerUserId, d.authorityEnvironmentId)
    if (!original) throw new HostAuthorityError('unavailable')
    const sourceExports = await options.sourceExports?.(profileId)
    guard()
    const currentCommittedCheckpoint =
      sourceExports?.committedCheckpoint(
        d,
        parseHostProjectMemoryCheckpoint({
          journalEpoch: original.anchor.journalEpoch,
          scopeDigest: d.scope.scopeDigest,
          recipientDigest: recipientDigest(d),
          sequence: original.anchor.syncStartSequence,
        }),
      ) ?? null
    const plan = store.plan(d)
    if (
      plan === null &&
      (d.operation === 'history_page' ||
        d.operation === 'delta_page' ||
        (d.operation === 'prepare_snapshot' && 'mode' in request.commandBody && request.commandBody.mode === 'resume'))
    )
      return parseHostProjectMemoryJson({
        status: 'error',
        code: 'source_changed',
        requestId: d.requestId,
        retryable: false,
      })
    const actualAccount = {
      authorityEnvironmentId: account.authorityEnvironmentId,
      accountIssuer: account.issuer,
      accountSubject: account.subject,
      accountBindingId: account.accountBindingHandle,
      accountBindingVersion: account.authorityBindingVersion,
      hostProfileId: profileId,
    }
    const raw = await options.execute(
      profileId,
      parseHostProjectMemoryJson({
        action: 'project_operation_memory',
        request: value,
        binding_key: bindingKey,
        actualAccount,
        actualPeer: {
          installationId: options.peer.installationId,
          publicKey: options.peer.publicKey,
          hostInstanceId: options.peer.hostInstanceId,
          processNonce: options.peer.processNonce,
        },
        confirmation: original.confirmation,
        anchor: original.anchor,
        plan,
        currentCommittedCheckpoint,
      }),
      signal,
    )
    guard()
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'status' in raw && raw.status === 'error') {
      const error = row(raw, ['status', 'code', 'requestId', 'retryable'])
      if (
        error.requestId !== d.requestId ||
        typeof error.code !== 'string' ||
        !codes.has(error.code) ||
        typeof error.retryable !== 'boolean'
      )
        throw new HostAuthorityError('unavailable')
      return parseHostProjectMemoryJson(parseHostProjectMemoryResponse(error))
    }
    const out = row(raw, [
      'operation',
      'sourceAuthorityVersion',
      'journalEpoch',
      'snapshotId',
      'previousCheckpoint',
      'ownership',
      'result',
    ])
    const owned = row(out.ownership, ['hostProfileId', 'botId', 'actorRef', 'sessionIds'])
    if (
      out.operation !== d.operation ||
      owned.hostProfileId !== profileId ||
      owned.botId !== d.scope.sourceRef.botRootId ||
      owned.actorRef !== d.scope.sourceRef.actorRef ||
      out.journalEpoch !== original.anchor.journalEpoch
    )
      throw new HostAuthorityError('unavailable')
    const result = parseHostProjectMemoryReadResult(d.operation, out.result)
    if (
      ('events' in result &&
        result.events.some(
          e =>
            e.sourcePolicy !== 'live_reference_v1' ||
            e.materialDependencies.length !== 0 ||
            e.originSide !== 'dsh' ||
            e.originActorRef !== d.scope.sourceRef.actorRef ||
            e.projectId !== d.scope.projectId ||
            !d.scope.materialKinds.includes(e.kind) ||
            e.sourceLocator.providerId !== d.scope.sourceRef.providerId ||
            (d.operation === 'history_page' &&
              (e.occurredAt < d.scope.historyFrom || e.occurredAt > d.scope.historyTo)),
        )) ||
      ('items' in result &&
        (result.materialVersions.length !== 0 ||
          result.items.some(
            i =>
              i.snippet !== '' ||
              i.rightId !== null ||
              i.rightGeneration !== null ||
              i.originSide !== 'dsh' ||
              i.originActorRef !== d.scope.sourceRef.actorRef ||
              !d.scope.materialKinds.includes(i.kind),
          ))) ||
      (d.operation === 'evidence' && (!('status' in result) || result.status !== 'missing'))
    )
      throw new HostAuthorityError('unavailable')
    if (
      'activationSequence' in result &&
      (result.activationSequence !== original.anchor.activationSequence ||
        result.syncStartSequence !==
          (d.operation === 'prepare_snapshot' && 'mode' in request.commandBody && request.commandBody.mode === 'delta'
            ? (currentCommittedCheckpoint?.sequence ?? original.anchor.syncStartSequence)
            : (plan?.syncStartSequence ?? original.anchor.syncStartSequence)) ||
        result.historyCut.from !== d.scope.historyFrom ||
        result.historyCut.to !== d.scope.historyTo ||
        result.historyCut.timeZone !== d.scope.timeZone)
    )
      throw new HostAuthorityError('unavailable')
    const checkpoints =
      'checkpoint' in result ? [result.checkpoint] : 'resumeRef' in result ? [result.resumeRef.checkpoint] : []
    if (
      checkpoints.some(
        c =>
          c.journalEpoch !== out.journalEpoch ||
          c.scopeDigest !== d.scope.scopeDigest ||
          c.recipientDigest !== recipientDigest(d),
      )
    )
      throw new HostAuthorityError('unavailable')
    const previousCheckpoint =
      out.previousCheckpoint === null ? null : parseHostProjectMemoryCheckpoint(out.previousCheckpoint)
    if (
      (d.operation === 'history_page' || d.operation === 'delta_page') !== (previousCheckpoint !== null) ||
      (previousCheckpoint &&
        (previousCheckpoint.journalEpoch !== out.journalEpoch ||
          previousCheckpoint.scopeDigest !== d.scope.scopeDigest ||
          previousCheckpoint.recipientDigest !== recipientDigest(d) ||
          ('scannedThroughSequence' in result &&
            BigInt(previousCheckpoint.sequence) > BigInt(result.scannedThroughSequence))))
    )
      throw new HostAuthorityError('unavailable')
    const issuedAt = options.now()
    const proof = parseHostProjectMemorySourceProof({
      schemaVersion: 1,
      purpose: 'project_operation_memory_source',
      side: 'dsh',
      issuer: account.issuer,
      keyId: options.peer.installationId,
      authorityEnvironmentId: d.authorityEnvironmentId,
      readDirectiveDigest: hostProjectMemoryDirectiveDigest(d),
      scopeDigest: d.scope.scopeDigest,
      bindingId: d.scope.bindingId,
      bindingGeneration: d.scope.bindingGeneration,
      scopeVersion: d.scope.scopeVersion,
      recipientDigest: recipientDigest(d),
      operation: d.operation,
      resultDigest: hostProjectMemoryReadResultDigest(d.operation, result),
      sourceActorRef: d.scope.sourceRef.actorRef,
      sourceAuthorityVersion: out.sourceAuthorityVersion,
      journalEpoch: out.journalEpoch,
      snapshotId: out.snapshotId,
      issuedAt,
      expiresAt: d.expiresAt,
      signature: 'A'.repeat(86),
    })
    parseHostProjectMemoryReadEnvelope(
      request,
      { status: 'ok', operation: d.operation, result, sourceProof: proof, projectionProof: null },
      previousCheckpoint === null ? {} : { previousCheckpoint },
    )
    if (
      plan &&
      (proof.sourceAuthorityVersion !== plan.sourceAuthorityVersion || proof.journalEpoch !== plan.journalEpoch)
    )
      return parseHostProjectMemoryJson({
        status: 'error',
        code: 'source_changed',
        requestId: d.requestId,
        retryable: false,
      })
    if (d.operation !== 'evidence')
      store.rememberPlan(
        d,
        proof.sourceAuthorityVersion,
        proof.journalEpoch,
        guard,
        'syncStartSequence' in result && plan?.syncStartSequence !== null ? result.syncStartSequence : undefined,
      )
    guard()
    const signature = options.sign(Buffer.from(encodeHostProjectMemorySourceProof(proof)))
    guard()
    if ('events' in result && previousCheckpoint !== null)
      store.publishRead(
        {
          proof: { ...proof, signature: signature as typeof proof.signature },
          requestId: d.requestId,
          previousCheckpoint,
          checkpoint: result.checkpoint,
          eventsDigest: projectOperationMemoryEventsDigest(result.events),
          eof: result.eof,
        },
        options.now(),
        guard,
      )
    guard()
    return parseHostProjectMemoryJson(
      parseHostProjectMemoryResponse({
        status: 'ok',
        operation: d.operation,
        result,
        sourceProof: { ...proof, signature },
        projectionProof: null,
      }),
    )
  } catch (error) {
    authorize()
    return parseHostProjectMemoryJson({
      status: 'error',
      code: signal.aborted || options.now() >= d.expiresAt ? 'timeout' : code(error),
      requestId: d.requestId,
      retryable: false,
    })
  }
}
function recipientDigest(d: HostProjectMemoryDirective): string {
  const r = d.scope.recipientRef
  return createHash('sha256')
    .update(
      'slark.project-operation-memory.recipient/v1\0' +
        JSON.stringify([r.side, r.botRef, r.audienceKind, r.audienceRef, r.audienceVersion, r.audienceDigest]),
    )
    .digest('hex')
}
