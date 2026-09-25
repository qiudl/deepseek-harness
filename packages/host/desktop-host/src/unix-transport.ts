import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type {
  HostExtensionCommand, HostExtensionResponse, HostExtensionKind, HostRemoteSessionCommand,
  HostRemoteSessionJson, ProfileExtensionsRequest, ProfileRemoteSessionRequest,
  ProfileRemoteUiReadRequest, ProfileRemoteUiStreamRequest, ProfileRemoteUiStreamResult,
  ProfileModelClaimInventoryRequest,
  ProfileModelClaimRecoveryInventoryRequest,
  ProfileModelClaimConfirmRequest, ProfileModelClaimApplyRequest,
  ProfileModelClaimRecoveryStatusRequest, ProfileModelClaimRestoreRequest,
  ProfileModelClaimRetryRequest,
  HostControlCapability,
  HostControlClientInstanceId,
  HostControlErrorCode,
  HostControlErrorFrame,
  HostControlFrame,
  HostControlJti,
  HostControlNonce,
  HostControlPublicKey,
  HostControlRequestId,
  HostControlSha256,
  HostControlSignature,
  HostInspectRequest,
  HostInspectResult,
  HostInstanceId,
  InstallationId,
  ProfileLeaseCloseRequest,
  ProfileEnsureRequest,
  ProfileRestoreRequest,
  ProfileBootstrapLocalRequest,
  ProfileRestoreLocalRequest,
  ProfileOpenRequest,
  ProfileOpenLocalRequest,
  ProfileViewActivateRequest,
  ProfileModelTextRequest,
  ProfileModelTextResult,
  ProfileStatusRequest,
  ProfileRecoveryInspectRequest,
  ProfileRecoverOfflineAccountRequest,
  ProfileOpenOfflineAccountRequest,
  ProfileRecoveryStatusRequest,
  MigrationExportBeginRequest,
  MigrationExportInventoryRequest,
  MigrationExistingSourceInventoryRequest,
  MigrationExportReadRequest,
  MigrationImportAbortRequest,
  MigrationImportCommitRequest,
  MigrationImportStageRequest,
  MigrationImportStatusRequest,
  MigrationImportVerifyRequest,
} from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import type { LegacyClaimCoordinator, LegacyClaimReceipt, LegacyClaimOutcome } from './legacy-claim-coordinator.ts'
import {
  HOST_CONTROL_MAX_FRAME_BYTES,
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostInspectSignaturePayload,
  migrationProfileSelectorHash,
} from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import type {
  HostAuthorityErrorCode,
  OfflineProfileOpenResult,
  PersonProfileId,
  ProfileOpenResult,
  ProfileViewLeaseId,
} from './types.ts'
import { HostAuthorityError } from './types.ts'
import { DesktopModelWorkerError } from './dsh-web-profile-worker.ts'
import type { DesktopHost } from './desktop-host.ts'
import type { LegacyModelClaimInventory } from './legacy-migration-source.ts'
import type { ProfileExtensionOperations } from './extension-operations.ts'
import { HostControlServerSession } from './host-control-session.ts'
import { RemoteUiStreamCursor } from './remote-ui-stream-cursor.ts'
import type { SingleHostLock } from './single-instance.ts'

/** Native peer evidence supplied by the embedding Desktop/Host process. */
export interface UnixPeerEvidence { readonly uid: number; readonly executableSignatureDigest: string }
/** Peer attestation must inspect the connected process, not the socket pathname. */
export type UnixPeerAttestor = (socket: Socket) => Promise<UnixPeerEvidence>

interface HostIdentity {
  readonly hostInstanceId: string
  readonly installationId: string
  readonly installationPublicKey: string
  readonly installationPrivateKey: KeyObject | string | Buffer
  readonly processNonce: string
  readonly executableSignatureDigest: string
  readonly runtimeGeneration: number
  readonly schemaGeneration: number
}

/** Server configuration for the owner-only Unix socket. */
export interface UnixHostServerOptions {
  readonly socketPath: string
  readonly ownership: SingleHostLock
  readonly expectedUid: number
  readonly allowedDesktopExecutableDigests: ReadonlySet<string>
  readonly attestPeer: UnixPeerAttestor
  readonly identity: HostIdentity
  readonly host: DesktopHost
  /** Call the Profile worker without exposing its private model token to Desktop. */
  readonly generateModelText?: (profileId: string, text: string, signal: AbortSignal) => Promise<{
    readonly provider: string
    readonly model: string
    readonly text: string
  }>
  /** Execute one bounded mobile session command inside the lease-selected Profile worker. */
  readonly remoteSession?: (
    profileId: string,
    command: HostRemoteSessionCommand,
    signal: AbortSignal,
  ) => Promise<HostRemoteSessionJson>
  /** Invoke only an exact read RPC in the Profile selected by the live view lease. */
  readonly remoteUiRead?: (
    profileId: string, endpoint: ProfileRemoteUiReadRequest['params']['endpoint'],
    payload: ProfileRemoteUiReadRequest['params']['payload'], signal: AbortSignal,
  ) => Promise<unknown>
  /** Open only the native Session-follow stream in the lease-selected worker. */
  readonly remoteUiStream?: (
    profileId: string, endpoint: 'session/follow', payload: Extract<ProfileRemoteUiStreamRequest['params']['command'],
      { action: 'open' }>['payload'], signal: AbortSignal,
  ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>
  /** Read-only source inspection; omitted on hosts without a validated legacy source. */
  readonly inspectModelClaimSource?: (signal?: AbortSignal) => Promise<LegacyModelClaimInventory>
  /** Initial claims require a fresh, connection-owned confirmation and a live Account view. */
  readonly modelClaimTransaction?: Pick<LegacyClaimCoordinator, 'claim'> & Partial<Pick<LegacyClaimCoordinator, 'retry'>>
  /** Worker-independent recovery of a durable same-Account claim receipt. */
  readonly modelClaimRecovery?: Pick<LegacyClaimCoordinator, 'pendingReceipts' | 'status' | 'restore'>
  readonly extensions?: {
    readonly operations: ProfileExtensionOperations
    readonly kinds: readonly HostExtensionKind[]
    readonly skillArchives?: boolean
    readonly pluginRemove?: boolean
    readonly pluginUpdate?: boolean
    readonly pluginToggle?: boolean
    readonly skillRemove?: boolean
    readonly skillReplace?: boolean
    readonly skillFiles?: boolean
    readonly skillInvocation?: boolean
    readonly mcpRemove?: boolean
    readonly mcpUpdate?: boolean
    inventory(profileId: string, kind: HostExtensionKind, signal?: AbortSignal):
    Promise<readonly { id: string; name: string; transport: string }[]>
  }
  readonly createMigrationExport?: (
    ownerId: string,
    profileId: string,
  ) => MigrationExportService | Promise<MigrationExportService>
  readonly createLegacyMigrationExport?: (
    ownerId: string,
    targetProfileId: string,
  ) => MigrationExportService | Promise<MigrationExportService>
  readonly createMigrationImport?: (ownerId: string, profileId: string) => MigrationImportService
  readonly profilePersistenceGeneration: (profileId: string) => number | Promise<number>
  readonly now?: () => number
}

/** Owner-connection-scoped semantic export service implemented by the active persistence backend. */
export interface MigrationExportService {
  inventory(signal?: AbortSignal): Promise<MigrationExportInventoryProof>
  begin(request: MigrationExportBeginInput, signal?: AbortSignal): Promise<MigrationExportReceipt>
  read(request: MigrationExportReadInput): MigrationExportChunk
}

interface MigrationExportInventoryProof {
  readonly inventoryDigest: string
  readonly sourceGeneration: string
  readonly schemaVersion: number
  readonly requiredMaxRecords: number
  readonly requiredMaxBytes: number
}

/** Owner-connection-scoped target import service; payload and paths remain inside the Host. */
export interface MigrationImportService {
  stage(input: {
    readonly transferId: string
    readonly transferDigest: string
    readonly sourceInstallationId: string
    readonly sourceInventoryDigest: string
    readonly sourceGeneration: string
    readonly sourceSchemaVersion: number
    readonly targetGeneration: number
    readonly targetProfileSelectorHash: string
    readonly recordCount: number
    readonly semanticDigest: string
  }): Promise<{
    readonly importId: string
    readonly version: number
    readonly targetGeneration: number
    readonly recordCount: number
    readonly semanticDigest: string
  }>
  status(input: {
    transferId: string
    targetGeneration: number
    sourceInstallationId: string
    targetProfileSelectorHash: string
  }): Promise<{
    readonly importId: string
    readonly version: number
    readonly state: 'preparing' | 'staged' | 'verified' | 'committed' | 'aborted'
    readonly targetGeneration: number
    readonly recordCount: number
    readonly semanticDigest: string
  }>
  verify(importId: string, expectedVersion: number): Promise<{
    readonly importId: string
    readonly version: number
    readonly semanticDigest: string
  }>
  commit(importId: string, expectedVersion: number, expectedCurrentGeneration: number): Promise<{
    readonly importId: string
    readonly version: number
    readonly targetGeneration: number
  }>
  abort(importId: string, expectedVersion: number): Promise<{ readonly importId: string; readonly version: number }>
}

interface MigrationExportBeginInput {
  readonly expectedInventoryDigest: string
  readonly maxRecords: number
  readonly maxBytes: number
}

interface MigrationExportReadInput {
  readonly exportId: string
  readonly chunkIndex: number
}

interface MigrationExportRecord {
  readonly collection: 'sessions' | 'session_events'
    | 'owner_settings' | 'owner_credentials' | 'owner_workspace' | 'owner_profile'
  readonly id: string
  readonly sessionId?: string
  readonly sequence: number
  readonly payloadDigest: string
}

interface MigrationExportReceipt {
  readonly exportId: string
  readonly transferId: string
  readonly transferDigest: string
  readonly schemaVersion: number
  readonly sourceGeneration: string
  readonly recordCount: number
  readonly firstEventSequence: number
  readonly lastEventSequence: number
  readonly semanticDigest: string
  readonly chunkCount: number
}

interface MigrationExportChunk {
  readonly exportId: string
  readonly chunkIndex: number
  readonly records: readonly MigrationExportRecord[]
  readonly chunkDigest: string
  readonly final: boolean
}

/** Transport-independent Host account, Profile, and migration authority inputs. */
export type HostControlAuthorityOptions = Pick<
  UnixHostServerOptions,
  'identity' | 'host' | 'inspectModelClaimSource' | 'createMigrationExport' | 'createLegacyMigrationExport'
    | 'createMigrationImport' | 'profilePersistenceGeneration' | 'now' | 'extensions'
    | 'modelClaimTransaction' | 'modelClaimRecovery' | 'generateModelText' | 'remoteSession' | 'remoteUiRead'
    | 'remoteUiStream'
>

/** Client trust roots and native Host process attestation. */
export interface UnixHostClientOptions {
  readonly socketPath: string
  readonly expectedUid: number
  readonly trustedInstallationId: string
  readonly trustedInstallationPublicKey: string
  readonly trustedExecutableSignatureDigest: string
  readonly attestPeer: UnixPeerAttestor
  readonly now?: () => number
}

/** Bounded discovery result consumed by Slark Desktop status policy. */
export type UnixHostDiscovery =
  | { readonly state: 'running'; readonly client: UnixHostClient; readonly inspection: HostInspectResult['result'] }
  | { readonly state: 'stopped'; readonly code: 'trusted_host_not_running' }
  | { readonly state: 'unknown'; readonly code: 'host_unverified' | 'transport_unavailable' }

const capabilities = [
  'host.inspect',
  'profile.lease_close',
  'profile.ensure',
  'profile.ensure_account_token',
  'profile.bootstrap_local',
  'profile.open',
  'profile.open_local',
  'profile.restore',
  'profile.restore_local',
  'profile.status',
  'profile.view_activate',
] as const satisfies readonly string[]

const recoveryCapabilities = [
  'profile.recovery_inspect',
  'profile.recover_offline_account',
  'profile.open_offline_account',
  'profile.recovery_status',
] as const satisfies readonly string[]

function nonce(): HostControlNonce { return randomBytes(32).toString('base64url') as HostControlNonce }
function requestId(): HostControlRequestId { return randomUUID() as HostControlRequestId }
function validSha256(value: string): boolean { return /^[0-9a-f]{64}$/.test(value) }

function errorReason(value: unknown): Error {
  return value instanceof Error ? value : new HostAuthorityError('unavailable')
}

function publicKeyObject(raw: string): KeyObject {
  const bytes = Buffer.from(raw, 'base64url')
  if (bytes.byteLength !== 32) throw new HostAuthorityError('unavailable')
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]),
    format: 'der',
    type: 'spki',
  })
}

function privateKeyObject(value: KeyObject | string | Buffer): KeyObject {
  return value instanceof Object && 'type' in value ? value : createPrivateKey(value)
}

interface ProfileSelectorPayload {
  readonly version: 1
  readonly installation_id: string
  readonly profile_id: string
  readonly binding_generation: number
  readonly runtime_generation: number
  readonly schema_generation: number
}

interface OfflineProfileSelectorPayload extends ProfileSelectorPayload {
  readonly access_scope: 'offline_local'
}

function migrationInventoryFields(proof: MigrationExportInventoryProof): {
  inventory_digest: never
  source_generation: never
  schema_version: number
  required_max_records: number
  required_max_bytes: number
} {
  return {
    inventory_digest: proof.inventoryDigest as never,
    source_generation: proof.sourceGeneration as never,
    schema_version: proof.schemaVersion,
    required_max_records: proof.requiredMaxRecords,
    required_max_bytes: proof.requiredMaxBytes,
  }
}

interface ReadyProfileIdentity {
  readonly profileId: string
  readonly bindingGeneration: number
}
function readyProfileFields(identity: HostIdentity, profile: ReadyProfileIdentity): {
  state: 'ready'
  profile_id: never
  profile_selector: string
} {
  return {
    state: 'ready', profile_id: profile.profileId as never,
    profile_selector: mintProfileSelector(identity, profile.profileId, profile.bindingGeneration),
  }
}

function localReadyProfileFields(
  identity: HostIdentity, profile: ReadyProfileIdentity, persistenceGeneration: number,
): ReturnType<typeof readyProfileFields> & { persistence_generation: number } {
  return { ...readyProfileFields(identity, profile), persistence_generation: persistenceGeneration }
}

interface OpenedProfileLease {
  readonly profileId: string
  readonly viewLeaseId: string
  readonly viewActivationHandle: string
  readonly leaseGeneration: number
  readonly expiresAt: number
  readonly runtimeGeneration: number
}

interface ProfileUnlockInput {
  readonly keyHandle: string
  readonly unlockMaterial: string
  readonly signal?: AbortSignal
}

interface AccountBindingInput {
  readonly authorityEnvironmentId: string
  readonly accountBindingHandle: string
  readonly authorityBindingVersion: number
}

interface ModelClaimRecoveryInput extends AccountBindingInput, ProfileUnlockInput {
  readonly issuer: string
  readonly subject: string
  readonly accountAccessToken: string
  readonly candidateId: string
}
function openProfileWireFields(opened: OpenedProfileLease): {
  profile_id: never
  view_lease_id: never
  view_activation_handle: never
  lease_generation: number
  expires_at: number
  runtime_generation: number
} {
  return {
    profile_id: opened.profileId as never, view_lease_id: opened.viewLeaseId as never,
    view_activation_handle: opened.viewActivationHandle as never,
    lease_generation: opened.leaseGeneration, expires_at: opened.expiresAt,
    runtime_generation: opened.runtimeGeneration,
  }
}

function openProfileResult(result: {
  readonly profile_id: string
  readonly view_lease_id: string
  readonly view_activation_handle: string
  readonly lease_generation: number
  readonly expires_at: number
  readonly runtime_generation: number
}): ProfileOpenResult {
  return {
    profileId: result.profile_id as never, viewLeaseId: result.view_lease_id as never,
    viewActivationHandle: result.view_activation_handle as never,
    leaseGeneration: result.lease_generation, expiresAt: result.expires_at,
    runtimeGeneration: result.runtime_generation,
  }
}

function readyProfileResult(result: { readonly profile_id: string; readonly profile_selector: string }): {
  readonly profileId: string
  readonly profileSelector: string
} {
  return { profileId: result.profile_id, profileSelector: result.profile_selector }
}

function localReadyProfileResult(result: {
  readonly profile_id: string
  readonly profile_selector: string
  readonly persistence_generation: number
}): { readonly profileId: string; readonly profileSelector: string; readonly persistenceGeneration: number } {
  return { ...readyProfileResult(result), persistenceGeneration: result.persistence_generation }
}

function profileUnlockFields(params: {
  readonly profile_key_handle: string
  readonly profile_unlock_material: string
}, ownerId: string): {
  keyHandle: string
  unlockMaterial: string
  ownerId: string
} {
  return {
    keyHandle: params.profile_key_handle,
    unlockMaterial: params.profile_unlock_material,
    ownerId,
  }
}

function accountBindingFields(params: {
  readonly authority_environment_id: string
  readonly account_binding_handle: string
  readonly authority_binding_version: number
}): {
  authorityEnvironmentId: string
  accountBindingHandle: string
  authorityBindingVersion: number
} {
  return {
    authorityEnvironmentId: params.authority_environment_id,
    accountBindingHandle: params.account_binding_handle,
    authorityBindingVersion: params.authority_binding_version,
  }
}

function mintProfileSelector(identity: HostIdentity, profileId: string, bindingGeneration: number): string {
  const payload: ProfileSelectorPayload = {
    version: 1, installation_id: identity.installationId, profile_id: profileId, binding_generation: bindingGeneration,
    runtime_generation: identity.runtimeGeneration, schema_generation: identity.schemaGeneration,
  }
  return mintSignedSelector(identity, 'dsh-profile-selector/v1', payload)
}

function verifyProfileSelector(identity: HostIdentity, selector: string): ProfileSelectorPayload {
  const value = verifySignedSelector(identity, selector, 'dsh-profile-selector/v1') as Partial<ProfileSelectorPayload>
  if (Object.keys(value).join(',') !== 'version,installation_id,profile_id,binding_generation,runtime_generation,schema_generation'
    || value.version !== 1 || value.installation_id !== identity.installationId
    || typeof value.profile_id !== 'string' || !Number.isSafeInteger(value.binding_generation) || (value.binding_generation ?? 0) < 1
    || value.runtime_generation !== identity.runtimeGeneration || value.schema_generation !== identity.schemaGeneration) {
    throw new HostAuthorityError('stale')
  }
  return value as ProfileSelectorPayload
}

function mintOfflineProfileSelector(identity: HostIdentity, profileId: string, bindingGeneration: number): string {
  const payload: OfflineProfileSelectorPayload = {
    version: 1, installation_id: identity.installationId, profile_id: profileId, binding_generation: bindingGeneration,
    runtime_generation: identity.runtimeGeneration, schema_generation: identity.schemaGeneration,
    access_scope: 'offline_local',
  }
  return mintSignedSelector(identity, 'dsh-profile-offline-selector/v1', payload)
}

function verifyOfflineProfileSelector(identity: HostIdentity, selector: string): OfflineProfileSelectorPayload {
  const value = verifySignedSelector(
    identity, selector, 'dsh-profile-offline-selector/v1',
  ) as Partial<OfflineProfileSelectorPayload>
  if (Object.keys(value).join(',') !== 'version,installation_id,profile_id,binding_generation,runtime_generation,schema_generation,access_scope'
    || value.version !== 1 || value.installation_id !== identity.installationId
    || typeof value.profile_id !== 'string' || !Number.isSafeInteger(value.binding_generation) || (value.binding_generation ?? -1) < 0
    || value.runtime_generation !== identity.runtimeGeneration || value.schema_generation !== identity.schemaGeneration
    || value.access_scope !== 'offline_local') throw new HostAuthorityError('stale')
  return value as OfflineProfileSelectorPayload
}

function mintSignedSelector(identity: HostIdentity, domain: string, payload: object): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign(null, Buffer.from(`${domain}\0${encoded}`), privateKeyObject(identity.installationPrivateKey))
    .toString('base64url')
  return `${encoded}.${signature}`
}

function verifySignedSelector(identity: HostIdentity, selector: string, domain: string): Record<string, unknown> {
  const [encoded, signature, extra] = selector.split('.')
  if (!encoded || !signature || extra !== undefined || !verify(
    null, Buffer.from(`${domain}\0${encoded}`), publicKeyObject(identity.installationPublicKey),
    Buffer.from(signature, 'base64url'),
  )) throw new HostAuthorityError('unauthorized')
  let payload: unknown
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown } catch {
    throw new HostAuthorityError('unauthorized')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new HostAuthorityError('unauthorized')
  return payload as Record<string, unknown>
}

function safeError(
  code: HostControlErrorCode,
  request: { request_id: HostControlRequestId; method: string },
): HostControlErrorFrame {
  return {
    version: 1,
    type: 'error',
    request_id: request.request_id,
    method: request.method as HostControlCapability,
    error: {
      code,
      retryable: ['busy', 'unavailable', 'recovery_in_progress', 'recovery_worker_failed', 'recovery_timeout_unknown'].includes(code),
      correlation_id: randomUUID() as never,
    },
  }
}

function authorityCode(error: unknown): HostControlErrorCode {
  if (!(error instanceof HostAuthorityError)) return 'internal_error'
  if (error.code === 'invalid_input') return 'invalid_frame'
  return error.code
}

function authorityCodeFromFrame(code: HostControlErrorCode): HostAuthorityErrorCode {
  switch (code) {
    case 'profile_locked':
    case 'profile_mismatch':
    case 'unauthorized':
    case 'replayed':
    case 'stale':
    case 'idempotency_conflict':
    case 'conflict':
    case 'busy':
    case 'upgrade_required':
    case 'script_approval_required':
    case 'profile_not_found':
    case 'profile_ambiguous':
    case 'profile_integrity_failed':
    case 'runtime_incompatible':
    case 'recovery_proof_mismatch':
    case 'recovery_preflight_stale':
    case 'recovery_in_progress':
    case 'recovery_worker_failed':
    case 'recovery_timeout_unknown':
    case 'scope_mismatch':
    case 'selector_stale':
    case 'lease_conflict':
      return code
    default:
      return 'unavailable'
  }
}

function migrationCode(error: unknown): HostControlErrorCode {
  if (error instanceof HostAuthorityError) return authorityCode(error)
  if (!(error instanceof Error)) return 'internal_error'
  if (error.message === 'migration_export_busy') return 'busy'
  if (error.message === 'migration_export_not_found') return 'stale'
  if (error.message === 'migration_export_bounds_invalid' || error.message === 'migration_export_request_invalid') {
    return 'invalid_frame'
  }
  if (error.message === 'migration_inventory_changed'
    || error.message === 'migration_source_changed'
    || error.message.startsWith('migration_export_too_')) return 'conflict'
  return 'internal_error'
}

function migrationImportCode(error: unknown): HostControlErrorCode {
  if (!(error instanceof Error)) return 'internal_error'
  if (error.message.endsWith('_invalid')) return 'invalid_frame'
  if (error.message.endsWith('_not_found') || error.message.endsWith('_stale')) return 'stale'
  if (error.message.endsWith('_conflict') || error.message.endsWith('_state')
    || error.message.endsWith('_generation_changed') || error.message.endsWith('_already_committed')
    || error.message.endsWith('_not_abortable')) return 'conflict'
  if (error.message.includes('_mismatch') || error.message.includes('_unsafe')) return 'unauthorized'
  return 'internal_error'
}

/** Internal request/response transport shared by socket and native Worker carriers. */
export interface HostClientFrameTransport {
  call(frame: HostControlFrame, signal?: AbortSignal): Promise<HostControlFrame>
  isConnected(): boolean
  close(): void
}

class FrameChannel implements HostClientFrameTransport {
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<string, { resolve(frame: HostControlFrame): void; reject(error: Error): void }>()
  private failed: Error | undefined
  private requestTail = Promise.resolve()

  constructor(readonly socket: Socket, private readonly onRequest?: (frame: HostControlFrame) => Promise<void>) {
    socket.on('data', (chunk) => { this.receive(chunk) })
    socket.on('error', (error) => { this.fail(error) })
    socket.on('close', () => { this.fail(new HostAuthorityError('unavailable')) })
  }

  send(frame: HostControlFrame): void { this.socket.write(encodeHostControlFrame(frame)) }

  /** Whether the authenticated transport is still usable by its owner. */
  isConnected(): boolean { return this.failed === undefined && !this.socket.destroyed }

  close(): void { this.socket.destroy() }

  call(frame: HostControlFrame, signal?: AbortSignal): Promise<HostControlFrame> {
    if (this.failed) return Promise.reject(this.failed)
    const id = frame.request_id
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.socket.destroy(new HostAuthorityError('unavailable'))
        reject(errorReason(signal?.reason))
      }
      if (signal?.aborted) { abort(); return }
      const cleanup = (): void => signal?.removeEventListener('abort', abort)
      this.pending.set(id, { resolve: (value) => { cleanup(); resolve(value) }, reject: (error) => { cleanup(); reject(error) } })
      signal?.addEventListener('abort', abort, { once: true })
      this.send(frame)
    })
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.byteLength > HOST_CONTROL_MAX_FRAME_BYTES + 1 && !this.buffer.includes(0x0a)) {
      this.socket.destroy(new HostAuthorityError('unavailable'))
      return
    }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline < 0) return
      if (newline > HOST_CONTROL_MAX_FRAME_BYTES) { this.socket.destroy(); return }
      const source = this.buffer.subarray(0, newline + 1).toString('utf8')
      this.buffer = this.buffer.subarray(newline + 1)
      let frame: HostControlFrame
      try { frame = decodeHostControlFrame(source) } catch { this.socket.destroy(); return }
      if (frame.type === 'result' || frame.type === 'error') {
        const waiter = this.pending.get(frame.request_id)
        if (!waiter) { this.socket.destroy(); return }
        this.pending.delete(frame.request_id)
        waiter.resolve(frame)
      } else if (this.onRequest) {
        const onRequest = this.onRequest
        this.requestTail = this.requestTail.then(() => onRequest(frame)).catch(() => { this.socket.destroy() })
      } else {
        this.socket.destroy()
      }
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return
    const reason = errorReason(error)
    this.failed = reason
    for (const waiter of this.pending.values()) waiter.reject(reason)
    this.pending.clear()
  }
}

/** Shared post-attestation authority used identically by Unix and Windows carriers. */
export class HostControlAuthority {
  constructor(private readonly options: HostControlAuthorityOptions) {}

  /** Open one connection-owned control session after the carrier has authenticated its peer. */
  openSession(ownerId: string, signal: AbortSignal): HostControlServerSession {
    const clock = this.options.now ?? Date.now
    const migrationExports = new Map<string, MigrationExportService>()
    const legacyAuthorities = new Map<string, {
      readonly profileId: string
      readonly expiresAt: number
      readonly service: MigrationExportService
      readonly exportIds: Set<string>
    }>()
    const claimConfirmations = new Map<string, {
      readonly profileId: PersonProfileId
      readonly viewLeaseId: string
      readonly leaseGeneration: number
      readonly runtimeGeneration: number
      readonly candidateId: string
      readonly sourceDigest: string
      readonly operationId: string
      readonly expiresAt: number
    }>()
    const remoteUiStreams = new Map<string, {
      readonly cursor: RemoteUiStreamCursor
      readonly profileId: string
      readonly viewLeaseId: string
      readonly leaseGeneration: number
      readonly runtimeGeneration: number
    }>()
    signal.addEventListener('abort', () => {
      for (const entry of remoteUiStreams.values()) void entry.cursor.close()
      remoteUiStreams.clear()
    }, { once: true })
    const migrationExportEnabled = this.options.createMigrationExport !== undefined
    const migrationExportFor = async (
      selector: string,
      sourceAuthority?: string,
      retainedExportId?: string,
    ): Promise<MigrationExportService> => {
      const decoded = verifyProfileSelector(this.options.identity, selector)
      const profileId = this.options.host.authorizeMigrationProfileSelector({
        profileId: decoded.profile_id as PersonProfileId,
        bindingGeneration: decoded.binding_generation,
        ownerId,
      })
      if (sourceAuthority !== undefined) {
        const authority = legacyAuthorities.get(sourceAuthority)
        if (!authority || authority.profileId !== profileId
          || (authority.expiresAt <= (this.options.now ?? Date.now)()
            && (retainedExportId === undefined || !authority.exportIds.has(retainedExportId)))) {
          throw new HostAuthorityError('stale')
        }
        return authority.service
      }
      let service = migrationExports.get(profileId)
      if (!service) {
        service = await this.options.createMigrationExport?.(ownerId, profileId)
        if (!service) throw new HostAuthorityError('unauthorized')
        migrationExports.set(profileId, service)
      }
      return service
    }
    const legacyMigrationEnabled = this.options.createLegacyMigrationExport !== undefined
    const migrationImportEnabled = this.options.createMigrationImport !== undefined
    const migrationFor = (selector: string): { service: MigrationImportService; selectorHash: string } => {
      const decoded = verifyProfileSelector(this.options.identity, selector)
      const profileId = this.options.host.authorizeMigrationProfileSelector({
        profileId: decoded.profile_id as PersonProfileId,
        bindingGeneration: decoded.binding_generation,
        ownerId,
      })
      const service = this.options.createMigrationImport?.(ownerId, profileId)
      if (!service) throw new HostAuthorityError('unauthorized')
      return { service, selectorHash: migrationProfileSelectorHash(selector) }
    }
    const session = new HostControlServerSession({
      ownerId,
      now: clock,
      signal,
      inspect: frame => this.inspect(
        frame, migrationExportEnabled, migrationImportEnabled, legacyMigrationEnabled,
        this.options.host.supportsOfflineAccountRecovery(),
      ),
      dispatchAuthorized: async (frame, context, respond) => {
        const channel = { send: respond }
        const accountClaimView = (viewLeaseId: string, leaseGeneration: number, runtimeGeneration: number) => {
          context.signal.throwIfAborted()
          return this.options.host.authorizeAccountModelClaimView({
            viewLeaseId: viewLeaseId as never, leaseGeneration, runtimeGeneration, ownerId,
          })
        }
        if (frame.method === 'profile.model_claim_confirm') {
          const inspectSource = this.options.inspectModelClaimSource
          if (!inspectSource || !this.options.modelClaimTransaction) throw new HostAuthorityError('upgrade_required')
          const authority = () => accountClaimView(frame.params.view_lease_id,
            frame.params.lease_generation, frame.params.runtime_generation)
          const profileId = authority()
          const inventory = await inspectSource(context.signal)
          if (authority() !== profileId) throw new HostAuthorityError('profile_mismatch')
          if (inventory.candidates.length > 128) throw new HostAuthorityError('unavailable')
          if (inventory.sourceDigest !== frame.params.source_digest
            || !inventory.candidates.some(candidate => candidate.id === frame.params.candidate_id
              && candidate.credential === 'present')) throw new HostAuthorityError('conflict')
          const now = clock()
          for (const [id, existing] of claimConfirmations) {
            if (existing.expiresAt <= now) claimConfirmations.delete(id)
          }
          if (claimConfirmations.size >= 32) throw new HostAuthorityError('busy')
          const confirmation = randomBytes(32).toString('base64url')
          const operationId = randomUUID()
          const expiresAt = now + 60_000
          claimConfirmations.set(confirmation, {
            profileId, viewLeaseId: frame.params.view_lease_id,
            leaseGeneration: frame.params.lease_generation, runtimeGeneration: frame.params.runtime_generation,
            candidateId: frame.params.candidate_id, sourceDigest: inventory.sourceDigest, operationId, expiresAt,
          })
          channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: { confirmation, operation_id: operationId, expires_at: expiresAt } })
        } else if (frame.method === 'profile.model_claim_apply') {
          const transaction = this.options.modelClaimTransaction
          if (!transaction) throw new HostAuthorityError('upgrade_required')
          const confirmed = claimConfirmations.get(frame.params.confirmation)
          if (!confirmed) throw new HostAuthorityError('stale')
          claimConfirmations.delete(frame.params.confirmation)
          if (confirmed.expiresAt <= clock()) throw new HostAuthorityError('stale')
          const authority = () => {
            context.signal.throwIfAborted()
            const profileId = accountClaimView(confirmed.viewLeaseId,
              confirmed.leaseGeneration, confirmed.runtimeGeneration)
            if (profileId !== confirmed.profileId) throw new HostAuthorityError('profile_mismatch')
            return profileId
          }
          authority()
          const outcome = await transaction.claim({ candidateId: confirmed.candidateId,
            operationId: confirmed.operationId, expectedSourceDigest: confirmed.sourceDigest,
            authorizeAccountProfile: authority, signal: context.signal })
          if (outcome.state !== 'committed') throw new HostAuthorityError('unavailable')
          this.options.host.revokeProfile(confirmed.profileId)
          channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: { state: 'committed', cleanup_pending: outcome.cleanupPending } })
        } else if (frame.method === 'profile.model_claim_recovery_inventory'
          || frame.method === 'profile.model_claim_recovery_status' || frame.method === 'profile.model_claim_restore'
          || frame.method === 'profile.model_claim_retry') {
          const service = this.options.modelClaimRecovery
          if (!service) throw new HostAuthorityError('upgrade_required')
          const proof = () => {
            context.signal.throwIfAborted()
            return this.options.host.authorizeAccountModelClaimRecovery({
              issuer: frame.params.account_issuer, subject: frame.params.account_subject,
              accountAccessToken: frame.params.account_access_token,
              authorityEnvironmentId: frame.params.authority_environment_id,
              accountBindingHandle: frame.params.account_binding_handle,
              authorityBindingVersion: frame.params.authority_binding_version,
              keyHandle: frame.params.profile_key_handle,
              unlockMaterial: frame.params.profile_unlock_material,
            })
          }
          if (frame.method === 'profile.model_claim_recovery_inventory') {
            const receipts = service.pendingReceipts({ authorizeAccountProfile: proof })
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
              result: { receipts: receipts.map(receipt => ({
                candidate_id: receipt.candidateId, operation_id: receipt.operationId,
                source_digest: receipt.sourceDigest as never, state: receipt.status,
              })) } })
          } else if (frame.method === 'profile.model_claim_recovery_status') {
            const receipt = service.status({ candidateId: frame.params.candidate_id, authorizeAccountProfile: proof })
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
              result: receipt ? { state: receipt.status, candidate_id: receipt.candidateId,
                operation_id: receipt.operationId, source_digest: receipt.sourceDigest as never }
                : { state: 'unclaimed' } })
          } else if (frame.method === 'profile.model_claim_restore') {
            const profileId = proof()
            const outcome = await service.restore({ candidateId: frame.params.candidate_id,
              operationId: frame.params.operation_id, authorizeAccountProfile: proof, signal: context.signal })
            if (outcome.state !== 'restored') throw new HostAuthorityError('unavailable')
            this.options.host.revokeProfile(profileId)
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
              result: { state: 'restored', cleanup_pending: outcome.cleanupPending } })
          } else {
            const retry = this.options.modelClaimTransaction?.retry
            if (!retry) throw new HostAuthorityError('upgrade_required')
            const profileId = proof()
            const outcome = await retry({ candidateId: frame.params.candidate_id,
              operationId: frame.params.operation_id, expectedSourceDigest: frame.params.source_digest,
              authorizeAccountProfile: proof, signal: context.signal })
            if (outcome.state !== 'committed') throw new HostAuthorityError('unavailable')
            this.options.host.revokeProfile(profileId)
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
              result: { state: 'committed', cleanup_pending: outcome.cleanupPending } })
          }
        } else if (frame.method === 'profile.model_claim_inventory') {
          const inspectSource = this.options.inspectModelClaimSource
          if (!inspectSource) throw new HostAuthorityError('upgrade_required')
          const authority = () => accountClaimView(frame.params.view_lease_id,
            frame.params.lease_generation, frame.params.runtime_generation)
          authority()
          const inventory = await inspectSource(context.signal)
          authority()
          if (inventory.candidates.length > 128) throw new HostAuthorityError('unavailable')
          channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
            source_digest: inventory.sourceDigest as never,
            candidates: inventory.candidates.map(candidate => ({
              id: candidate.id, provider: candidate.provider, kind: candidate.kind,
              credential: candidate.credential, shared_credential: candidate.sharedCredential,
            })),
            unsupported_settings: inventory.unsupportedSettings,
            unassigned_credential_references: inventory.unassignedCredentialReferences,
            unassigned_credential_records: inventory.unassignedCredentialRecords,
          } })
        } else if (frame.method === 'migration.existing_source.inventory') {
          try {
            const decoded = verifyProfileSelector(this.options.identity, frame.params.target_profile_selector)
            const profileId = this.options.host.authorizeMigrationProfileSelector({
              profileId: decoded.profile_id as PersonProfileId,
              bindingGeneration: decoded.binding_generation,
              ownerId,
            })
            const service = await this.options.createLegacyMigrationExport?.(ownerId, profileId)
            if (!service) throw new HostAuthorityError('unavailable')
            const proof = await service.inventory(context.signal)
            const authority = randomBytes(32).toString('base64url')
            const expiresAt = (this.options.now ?? Date.now)() + 60_000
            legacyAuthorities.set(authority, { profileId, expiresAt, service, exportIds: new Set() })
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              source_inventory_authority: authority as never,
              source_installation_id: this.options.identity.installationId as never,
              expires_at: expiresAt,
              ...migrationInventoryFields(proof),
            } })
          } catch (error) { channel.send(safeError(migrationCode(error), frame)) }
        } else if (frame.method === 'migration.export_snapshot.inventory') {
          try {
            const migrationExport = await migrationExportFor(
              frame.params.source_profile_selector, frame.params.source_inventory_authority,
            )
            const proof = await migrationExport.inventory(context.signal)
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
              result: migrationInventoryFields(proof) })
          } catch (error) { channel.send(safeError(migrationCode(error), frame)) }
        } else if (frame.method === 'migration.export_snapshot.begin') {
          try {
            const migrationExport = await migrationExportFor(
              frame.params.source_profile_selector, frame.params.source_inventory_authority,
            )
            const receipt = await migrationExport.begin({
              expectedInventoryDigest: frame.params.expected_inventory_digest,
              maxRecords: frame.params.max_records,
              maxBytes: frame.params.max_bytes,
            }, context.signal)
            if (frame.params.source_inventory_authority !== undefined) {
              legacyAuthorities.get(frame.params.source_inventory_authority)?.exportIds.add(receipt.exportId)
            }
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              export_id: receipt.exportId,
              transfer_id: receipt.transferId as never,
              transfer_digest: receipt.transferDigest as never,
              schema_version: receipt.schemaVersion,
              source_generation: receipt.sourceGeneration as never,
              record_count: receipt.recordCount,
              first_event_sequence: receipt.firstEventSequence,
              last_event_sequence: receipt.lastEventSequence,
              semantic_digest: receipt.semanticDigest as never, chunk_count: receipt.chunkCount,
            } })
          } catch (error) { channel.send(safeError(migrationCode(error), frame)) }
        } else if (frame.method === 'migration.export_snapshot.read') {
          try {
            const migrationExport = await migrationExportFor(
              frame.params.source_profile_selector, frame.params.source_inventory_authority, frame.params.export_id,
            )
            const chunk = migrationExport.read({
              exportId: frame.params.export_id,
              chunkIndex: frame.params.chunk_index,
            })
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              export_id: chunk.exportId, chunk_index: chunk.chunkIndex,
              records: chunk.records.map(record => ({
                collection: record.collection,
                id: record.id,
                ...(record.sessionId === undefined ? {} : { session_id: record.sessionId }),
                sequence: record.sequence,
                payload_digest: record.payloadDigest as never,
              })),
              chunk_digest: chunk.chunkDigest as never, final: chunk.final,
            } })
          } catch (error) { channel.send(safeError(migrationCode(error), frame)) }
        } else if (frame.method === 'migration.import_snapshot.stage') {
          try {
            const scoped = migrationFor(frame.params.target_profile_selector)
            const stage = await scoped.service.stage({
              transferId: frame.params.transfer_id, transferDigest: frame.params.transfer_digest,
              sourceInstallationId: frame.params.source_installation_id,
              sourceInventoryDigest: frame.params.source_inventory_digest,
              sourceGeneration: frame.params.source_generation, sourceSchemaVersion: frame.params.source_schema_version,
              targetGeneration: frame.params.target_generation, targetProfileSelectorHash: scoped.selectorHash,
              recordCount: frame.params.record_count,
              semanticDigest: frame.params.semantic_digest,
            })
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              import_id: stage.importId as never, stage_version: stage.version, state: 'staged',
              target_generation: stage.targetGeneration, record_count: stage.recordCount,
              semantic_digest: stage.semanticDigest as never,
            } })
          } catch (error) { channel.send(safeError(migrationImportCode(error), frame)) }
        } else if (frame.method === 'migration.import_snapshot.status') {
          try {
            const scoped = migrationFor(frame.params.target_profile_selector)
            const stage = await scoped.service.status({
              transferId: frame.params.transfer_id, targetGeneration: frame.params.target_generation,
              sourceInstallationId: frame.params.source_installation_id,
              targetProfileSelectorHash: scoped.selectorHash,
            })
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              import_id: stage.importId as never, stage_version: stage.version, state: stage.state,
              target_generation: stage.targetGeneration, record_count: stage.recordCount,
              semantic_digest: stage.semanticDigest as never,
            } })
          } catch (error) { channel.send(safeError(migrationImportCode(error), frame)) }
        } else if (frame.method === 'migration.import_snapshot.verify') {
          try {
            const stage = await migrationFor(frame.params.target_profile_selector).service.verify(
              frame.params.import_id, frame.params.expected_stage_version,
            )
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              import_id: stage.importId as never, stage_version: stage.version, verified: true,
              semantic_digest: stage.semanticDigest as never,
            } })
          } catch (error) { channel.send(safeError(migrationImportCode(error), frame)) }
        } else if (frame.method === 'migration.import_snapshot.commit') {
          try {
            const stage = await migrationFor(frame.params.target_profile_selector).service.commit(
              frame.params.import_id, frame.params.expected_stage_version, frame.params.expected_current_generation,
            )
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              import_id: stage.importId as never, stage_version: stage.version, committed: true,
              active_generation: stage.targetGeneration,
            } })
          } catch (error) { channel.send(safeError(migrationImportCode(error), frame)) }
        } else if (frame.method === 'migration.import_snapshot.abort') {
          try {
            const stage = await migrationFor(frame.params.target_profile_selector).service.abort(
              frame.params.import_id, frame.params.expected_stage_version,
            )
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              import_id: stage.importId as never, stage_version: stage.version, aborted: true,
            } })
          } catch (error) { channel.send(safeError(migrationImportCode(error), frame)) }
        } else if (frame.method === 'profile.recovery_inspect') {
          const inspected = await this.options.host.inspectOfflineAccountProfiles({
            keyHandles: frame.params.profile_key_handles,
            expectedRuntimeGeneration: frame.params.expected_runtime_generation,
            expectedSchemaGeneration: frame.params.expected_schema_generation,
            ownerId,
          })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: {
              candidates: inspected.candidates.map(candidate => ({
                state: candidate.state, candidate_id: candidate.candidateId as never,
                profile_kind: candidate.profileKind, binding_count: candidate.bindingCount,
                persistence_generation: candidate.persistenceGeneration, session_count: candidate.sessionCount,
                plugin_count: candidate.pluginCount, compatibility: candidate.compatibility,
                preflight_digest: candidate.preflightDigest as never,
                ...(candidate.reasonCode === undefined ? {} : { reason_code: candidate.reasonCode }),
              })),
            },
          })
        } else if (frame.method === 'profile.recover_offline_account') {
          const recovered = await this.options.host.recoverOfflineAccountProfile({
            candidateId: frame.params.candidate_id as never,
            preflightDigest: frame.params.preflight_digest,
            keyHandle: frame.params.profile_key_handle,
            unlockMaterial: frame.params.profile_unlock_material,
            operationId: frame.params.recovery_operation_id,
            ownerId,
          })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: {
              state: 'offline_ready',
              profile_selector: mintOfflineProfileSelector(
                this.options.identity, recovered.profileId, recovered.bindingGeneration,
              ),
              access_scope: 'offline_local', persistence_generation: recovered.persistenceGeneration,
              runtime_generation: recovered.runtimeGeneration,
            },
          })
        } else if (frame.method === 'profile.open_offline_account') {
          const selector = verifyOfflineProfileSelector(this.options.identity, frame.params.profile_selector)
          const opened = await this.options.host.openOfflineAccountProfile({
            profileId: selector.profile_id as never, bindingGeneration: selector.binding_generation, ownerId,
          })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: { ...openProfileWireFields(opened), access_scope: 'offline_local' },
          })
        } else if (frame.method === 'profile.recovery_status') {
          const status = this.options.host.getOfflineAccountRecoveryStatus({
            operationId: frame.params.recovery_operation_id, ownerId,
          })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: status.state === 'failed'
              ? { state: 'failed', reason_code: status.reasonCode }
              : { state: status.state },
          })
        } else if (frame.method === 'profile.ensure' || frame.method === 'profile.restore') {
          let profile: ReadyProfileIdentity
          if (frame.method === 'profile.ensure') {
            if (!frame.params.account_access_token) throw new HostAuthorityError('upgrade_required')
            profile = await this.options.host.ensureAccountProfile({
              accountAccessToken: frame.params.account_access_token,
              issuer: frame.params.account_issuer,
              subject: frame.params.account_subject,
              ...accountBindingFields(frame.params),
              ...profileUnlockFields(frame.params, ownerId),
            })
          } else {
            const selector = verifyProfileSelector(this.options.identity, frame.params.profile_selector)
            profile = await this.options.host.restoreProfile({
              profileId: selector.profile_id as never,
              bindingGeneration: selector.binding_generation,
              ...accountBindingFields(frame.params),
              ...profileUnlockFields(frame.params, ownerId),
            })
          }
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: readyProfileFields(this.options.identity, profile),
          })
        } else if (frame.method === 'profile.bootstrap_local' || frame.method === 'profile.restore_local') {
          let profile: ReadyProfileIdentity
          if (frame.method === 'profile.bootstrap_local') {
            profile = await this.options.host.bootstrapLocalProfile(profileUnlockFields(frame.params, ownerId))
          } else {
            const selector = verifyProfileSelector(this.options.identity, frame.params.profile_selector)
            profile = await this.options.host.restoreLocalProfile({
              profileId: selector.profile_id as never,
              bindingGeneration: selector.binding_generation,
              ...profileUnlockFields(frame.params, ownerId),
            })
          }
          const persistenceGeneration = await this.options.profilePersistenceGeneration(profile.profileId)
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: localReadyProfileFields(this.options.identity, profile, persistenceGeneration),
          })
        } else if (frame.method === 'profile.status') {
          const status = this.options.host.getProfileStatus({
            authorityEnvironmentId: frame.params.authority_environment_id,
            accountBindingHandle: frame.params.account_binding_handle,
            authorityBindingVersion: frame.params.authority_binding_version,
            ownerId,
          })
          const persistenceGeneration = status.state === 'ready'
            ? await this.options.profilePersistenceGeneration(status.profileId)
            : undefined
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: 'profile.status',
            result: status.state === 'ready'
              ? { state: 'ready', profile_id: status.profileId as never, persistence_generation: persistenceGeneration as number }
              : { state: status.state },
          })
        } else if (frame.method === 'profile.open') {
          const opened = await this.options.host.openProfile({
            authorityEnvironmentId: frame.params.authority_environment_id,
            accountBindingHandle: frame.params.account_binding_handle,
            authorityBindingVersion: frame.params.authority_binding_version, ownerId,
          })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: 'profile.open',
            result: openProfileWireFields(opened),
          })
        } else if (frame.method === 'profile.open_local') {
          const selector = verifyProfileSelector(this.options.identity, frame.params.profile_selector)
          const opened = await this.options.host.openLocalProfile({ profileId: selector.profile_id as never, ownerId })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: openProfileWireFields(opened),
          })
        } else if (frame.method === 'profile.extensions') {
          const extension = this.options.extensions
          if (!extension) throw new HostAuthorityError('upgrade_required')
          const authority = () => {
            if (signal.aborted) throw new HostAuthorityError('stale')
            return this.options.host.authorizeExtensionView({ viewLeaseId: frame.params.view_lease_id as never,
              leaseGeneration: frame.params.lease_generation, runtimeGeneration: frame.params.runtime_generation, ownerId })
          }
          const profileId = authority()
          const command = frame.params.command
          if ('kind' in command && !extension.kinds.includes(command.kind)) throw new HostAuthorityError('upgrade_required')
          let result: HostExtensionResponse
          try {
            if (command.action === 'inventory') {
              const entries = await extension.inventory(profileId, command.kind, signal)
              authority()
              result = { state: 'inventory', kind: command.kind, entries, ...(command.kind === 'plugin' && extension.pluginRemove ? { plugin_remove: true } : {}), ...(command.kind === 'plugin' && extension.pluginUpdate ? { plugin_update: true } : {}), ...(command.kind === 'plugin' && extension.pluginToggle ? { plugin_toggle: true } : {}), ...(command.kind === 'skill' && extension.skillArchives ? { skill_archives: true } : {}), ...(command.kind === 'skill' && extension.skillRemove ? { skill_remove: true } : {}), ...(command.kind === 'skill' && extension.skillReplace ? { skill_replace: true } : {}), ...(command.kind === 'skill' && extension.skillFiles ? { skill_files: true } : {}), ...(command.kind === 'skill' && extension.skillInvocation ? { skill_invocation: true } : {}), ...(command.kind === 'mcp' && extension.mcpRemove ? { mcp_remove: true } : {}), ...(command.kind === 'mcp' && extension.mcpUpdate ? { mcp_update: true } : {}) }
            } else if (command.action === 'prepare') {
              const plan = await extension.operations.prepare(authority, command.kind, command.payload)
              result = { state: 'prepared', plan_id: plan.planId as never, kind: plan.kind,
                digest: plan.digest as never, expires_at: plan.expiresAt,
                ...(plan.scriptApproval ? {
                  scripts: plan.scriptApproval.scripts, script_digest: plan.scriptApproval.digest as never,
                } : {}) }
            } else {
              const receipt = command.action === 'commit'
                ? extension.operations.commit(authority, command.plan_id, command.operation_id, signal, command.script_digest)
                : command.action === 'cancel'
                  ? extension.operations.cancel(authority, command.operation_id)
                  : extension.operations.status(authority, command.operation_id)
              result = { state: 'receipt', operation_id: receipt.operationId as never, outcome: receipt.state,
                cancellation_requested: receipt.cancellationRequested, created_at: receipt.createdAt, updated_at: receipt.updatedAt,
                ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
                ...(receipt.skillSource === undefined ? {} : { skill_source: receipt.skillSource }),
                ...(receipt.canRestore && receipt.skillRemoval ? { skill_restore: receipt.skillRemoval.entryId } : {}),
                ...(receipt.canRestore && receipt.mcpRecovery ? { mcp_restore: true as const } : {}),
                ...(receipt.canRestore && receipt.pluginToggleRecovery ? { plugin_restore: receipt.pluginToggleRecovery.packageName } : {}),
                ...(receipt.canComplete && receipt.pluginPackage ? { plugin_complete: { action: receipt.pluginPackage.action,
                  package_name: receipt.pluginPackage.packageName,
                  ...(receipt.pluginPackage.spec ? { spec: receipt.pluginPackage.spec } : {}) } } : {}),
                ...(receipt.restoredBy ? { restored_by: receipt.restoredBy as never } : {}),
                ...(receipt.restores && receipt.recoveryMode !== 'complete' ? { restores_operation: receipt.restores as never } : {}),
                ...(receipt.completedBy ? { completed_by: receipt.completedBy as never } : {}),
                ...(receipt.restores && receipt.recoveryMode === 'complete' ? { completes_operation: receipt.restores as never } : {}) }
            }
          } catch (error) {
            if (error instanceof HostAuthorityError) throw error
            const code = error instanceof Error ? error.message : ''
            if (code === 'expired') throw new HostAuthorityError('stale')
            if (code === 'busy' || code === 'idempotency_conflict' || code === 'unauthorized'
              || code === 'upgrade_required' || code === 'script_approval_required') {
              throw new HostAuthorityError(code)
            }
            throw new HostAuthorityError('invalid_input')
          }
          channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result })
        } else if (frame.method === 'profile.remote_ui_stream') {
          const command = frame.params.command
          const revokeCursor = async () => {
            const entry = remoteUiStreams.get(command.stream_id)
            if (entry && entry.viewLeaseId === frame.params.view_lease_id
              && entry.leaseGeneration === frame.params.lease_generation
              && entry.runtimeGeneration === frame.params.runtime_generation) {
              remoteUiStreams.delete(command.stream_id)
              await entry.cursor.close()
            }
          }
          const authority = () => {
            context.signal.throwIfAborted()
            try {
              return this.options.host.authorizeExtensionView({
                viewLeaseId: frame.params.view_lease_id as never,
                leaseGeneration: frame.params.lease_generation,
                runtimeGeneration: frame.params.runtime_generation, ownerId,
              })
            } catch (error) { void revokeCursor(); throw error }
          }
          const profileId = authority()
          let result: ProfileRemoteUiStreamResult['result']
          if (command.action === 'open') {
            const execute = this.options.remoteUiStream
            if (!execute) throw new HostAuthorityError('upgrade_required')
            if (remoteUiStreams.has(command.stream_id) || remoteUiStreams.size >= 8) {
              throw new HostAuthorityError('conflict')
            }
            const cursor = await RemoteUiStreamCursor.open(
              cursorSignal => execute(profileId, command.endpoint, command.payload, cursorSignal), signal)
            try {
              if (authority() !== profileId) throw new HostAuthorityError('profile_mismatch')
              remoteUiStreams.set(command.stream_id, { cursor, profileId,
                viewLeaseId: frame.params.view_lease_id,
                leaseGeneration: frame.params.lease_generation,
                runtimeGeneration: frame.params.runtime_generation })
              result = { type: 'opened' }
            } catch (error) { await cursor.close(); throw error }
          } else {
            const entry = remoteUiStreams.get(command.stream_id)
            if (!entry || entry.profileId !== profileId || entry.viewLeaseId !== frame.params.view_lease_id
              || entry.leaseGeneration !== frame.params.lease_generation
              || entry.runtimeGeneration !== frame.params.runtime_generation) throw new HostAuthorityError('stale')
            if (command.action === 'close') {
              remoteUiStreams.delete(command.stream_id)
              await entry.cursor.close()
              result = { type: 'closed' }
            } else {
              result = entry.cursor.poll()
              if (result.type === 'end' || result.type === 'error') {
                remoteUiStreams.delete(command.stream_id)
                await entry.cursor.close()
              }
            }
          }
          if (authority() !== profileId) {
            await revokeCursor()
            throw new HostAuthorityError('profile_mismatch')
          }
          channel.send({ version: 1, type: 'result', request_id: frame.request_id,
            method: frame.method, result })
        } else if (frame.method === 'profile.remote_session' || frame.method === 'profile.remote_ui_read') {
          const authority = () => {
            context.signal.throwIfAborted()
            return this.options.host.authorizeExtensionView({
              viewLeaseId: frame.params.view_lease_id as never,
              leaseGeneration: frame.params.lease_generation,
              runtimeGeneration: frame.params.runtime_generation,
              ownerId,
            })
          }
          const profileId = authority()
          let value: HostRemoteSessionJson
          if (frame.method === 'profile.remote_session') {
            const execute = this.options.remoteSession
            if (!execute) throw new HostAuthorityError('upgrade_required')
            value = await execute(profileId, frame.params.command, context.signal)
          } else {
            const execute = this.options.remoteUiRead
            if (!execute) throw new HostAuthorityError('upgrade_required')
            value = await execute(profileId, frame.params.endpoint, frame.params.payload, context.signal) as HostRemoteSessionJson
          }
          if (authority() !== profileId) throw new HostAuthorityError('profile_mismatch')
          const response: HostControlFrame = { version: 1, type: 'result', request_id: frame.request_id,
            method: frame.method, result: { value } }
          channel.send(decodeHostControlFrame(encodeHostControlFrame(response)))
        } else if (frame.method === 'profile.model_text') {
          const generate = this.options.generateModelText
          if (!generate) throw new HostAuthorityError('upgrade_required')
          const account = {
            authorityEnvironmentId: frame.params.authority_environment_id,
            accountBindingHandle: frame.params.account_binding_handle,
            authorityBindingVersion: frame.params.authority_binding_version,
            ownerId,
          }
          const profileId = this.options.host.authorizeAccountModelText(account)
          let result: { readonly state: 'complete'; readonly provider: string; readonly model: string; readonly text: string }
            | { readonly state: 'rejected'; readonly code: DesktopModelWorkerError['code'] }
          try {
            const answer = await generate(profileId, frame.params.text, context.signal)
            context.signal.throwIfAborted()
            this.options.host.authorizeAccountModelText(account)
            result = { state: 'complete', ...answer }
          } catch (error) {
            if (error instanceof HostAuthorityError) throw error
            result = { state: 'rejected', code: error instanceof DesktopModelWorkerError
              ? error.code : context.signal.aborted ? 'cancelled' : 'provider_failed' }
          }
          channel.send({ version: 1, type: 'result', request_id: frame.request_id,
            method: 'profile.model_text', result })
        } else if (frame.method === 'profile.view_activate') {
          const activated = await this.options.host.activateView({
            profileId: frame.params.profile_id as never,
            viewLeaseId: frame.params.view_lease_id as never,
            viewActivationHandle: frame.params.view_activation_handle as never,
            leaseGeneration: frame.params.lease_generation,
            runtimeGeneration: frame.params.runtime_generation,
            ownerId,
          })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: 'profile.view_activate',
            result: {
              origin: activated.origin,
              activation_generation: activated.activationGeneration,
              expires_at: activated.expiresAt,
              bootstrap_cookie: activated.bootstrapCookie,
            },
          })
        } else {
          this.options.host.closeOwnedViewLease({
            viewLeaseId: frame.params.view_lease_id as unknown as ProfileViewLeaseId,
            leaseGeneration: frame.params.lease_generation,
            runtimeGeneration: frame.params.runtime_generation,
            ownerId,
          })
          channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: 'profile.lease_close', result: { closed: true } })
        }
      },
      errorResponse: (frame, error) => safeError(authorityCode(error), frame),
      revokeOwner: (connectionOwnerId) => { this.options.host.revokeOwner(connectionOwnerId) },
    })
    return session
  }

  private inspect(
    request: HostInspectRequest,
    migrationExport: boolean,
    migrationImport: boolean,
    legacyMigration: boolean,
    offlineAccountRecovery: boolean,
  ): HostInspectResult {
    if (!request.params.supported_versions.includes(1)) throw new HostAuthorityError('unavailable')
    const identity = this.options.identity
    const unsigned: HostInspectResult = {
      version: 1,
      type: 'result',
      request_id: request.request_id,
      method: 'host.inspect',
      result: {
        protocol_version: 1,
        host_instance_id: identity.hostInstanceId as HostInstanceId,
        installation_id: identity.installationId as InstallationId,
        installation_public_key: identity.installationPublicKey as HostControlPublicKey,
        runtime_generation: identity.runtimeGeneration,
        schema_generation: identity.schemaGeneration,
        process_nonce: identity.processNonce as HostControlNonce,
        capabilities: [
          ...capabilities,
          ...(this.options.generateModelText ? ['profile.model_text'] : []),
          ...(this.options.remoteSession ? ['profile.remote_session'] : []),
          ...(this.options.remoteUiRead ? ['profile.remote_ui_read'] : []),
          ...(this.options.remoteUiStream ? ['profile.remote_ui_stream'] : []),
          ...(this.options.inspectModelClaimSource ? ['profile.model_claim_inventory'] : []),
          ...(this.options.inspectModelClaimSource && this.options.modelClaimTransaction
            ? ['profile.model_claim_confirm', 'profile.model_claim_apply'] : []),
          ...(this.options.modelClaimRecovery ? ['profile.model_claim_recovery_inventory',
            'profile.model_claim_recovery_status', 'profile.model_claim_restore'] : []),
          ...(this.options.modelClaimRecovery && this.options.modelClaimTransaction?.retry && this.options.inspectModelClaimSource
            ? ['profile.model_claim_retry'] : []),
          ...(this.options.extensions ? ['profile.extensions'] : []),
          ...(offlineAccountRecovery ? recoveryCapabilities : []),
          ...(migrationExport ? [
            'migration.export_snapshot.inventory', 'migration.export_snapshot.begin', 'migration.export_snapshot.read',
          ] : []),
          ...(legacyMigration ? ['migration.existing_source.inventory'] : []),
          ...(migrationImport ? [
            'migration.import_snapshot.abort', 'migration.import_snapshot.commit',
            'migration.import_snapshot.stage', 'migration.import_snapshot.status', 'migration.import_snapshot.verify',
          ] : []),
        ]
          .sort().map(value => value as HostControlCapability),
        challenge_signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as HostControlSignature,
        executable_signature_digest: identity.executableSignatureDigest as HostControlSha256,
      },
    }
    const signature = sign(
      null,
      encodeHostInspectSignaturePayload(request, unsigned),
      privateKeyObject(identity.installationPrivateKey),
    ).toString('base64url') as HostControlSignature
    return { ...unsigned, result: { ...unsigned.result, challenge_signature: signature } }
  }
}

/** Running owner-only UDS server. */
export class UnixHostServer {
  private server: Server | undefined
  private socketIdentity?: { dev: number; ino: number }
  private readonly connections = new Set<Socket>()
  private readonly authority: HostControlAuthority
  constructor(private readonly options: UnixHostServerOptions) {
    this.authority = new HostControlAuthority(options)
  }

  /** Bind the UDS path after refusing link/regular-file substitution. */
  async start(): Promise<void> {
    if (this.server) throw new HostAuthorityError('conflict')
    this.options.ownership.assertOwner()
    try {
      const stat = lstatSync(this.options.socketPath)
      if (!stat.isSocket() || stat.uid !== this.options.expectedUid) throw new HostAuthorityError('conflict')
      this.options.ownership.assertOwner()
      unlinkSync(this.options.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const server = createServer((socket) => { void this.accept(socket) })
    delete this.socketIdentity
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.options.socketPath, () => {
          server.off('error', reject)
          resolve()
        })
      })
      chmodSync(this.options.socketPath, 0o600)
      const stat = lstatSync(this.options.socketPath)
      this.socketIdentity = { dev: stat.dev, ino: stat.ino }
    } catch (error) {
      this.server = undefined
      /* v8 ignore next 1 -- reaching cleanup requires a filesystem race after the listener has bound successfully. */
      if (server.listening) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      throw error
    }
  }

  /** Close connections and remove only the socket inode this server created. */
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    for (const socket of this.connections) socket.destroy()
    await this.options.extensions?.operations.dispose()
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
    try {
      const stat = lstatSync(this.options.socketPath)
      if (this.socketIdentity && stat.isSocket()
        && stat.dev === this.socketIdentity.dev && stat.ino === this.socketIdentity.ino) {
        unlinkSync(this.options.socketPath)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async accept(socket: Socket): Promise<void> {
    const ownerId = randomUUID()
    const transportLifetime = new AbortController()
    this.connections.add(socket)
    socket.once('close', () => {
      transportLifetime.abort()
      this.connections.delete(socket)
    })
    socket.pause()
    try {
      const peer = await this.options.attestPeer(socket)
      if (peer.uid !== this.options.expectedUid || !validSha256(peer.executableSignatureDigest)
        || !this.options.allowedDesktopExecutableDigests.has(peer.executableSignatureDigest)) {
        throw new HostAuthorityError('unauthorized')
      }
    } catch { socket.destroy(); return }
    const session = this.authority.openSession(ownerId, transportLifetime.signal)
    const channel = new FrameChannel(socket, async (frame) => {
      channel.send(await session.handleRequest(frame))
    })
    socket.resume()
  }

}

interface HandshakeState {
  readonly clientInstanceId: HostControlClientInstanceId
  readonly hostInstanceId: HostInstanceId
  readonly processNonce: HostControlNonce
}

/** Connected Main-only SDK matching Slark's `DshPersonalHostAdapter`. */
export class UnixHostClient {
  private constructor(
    private readonly channel: HostClientFrameTransport,
    private readonly state: HandshakeState,
    private readonly now: () => number,
    readonly inspection: HostInspectResult['result'],
  ) {}

  /**
   * Connect, attest the Host process, and verify its signed fresh challenge.
   * @param options - trusted installation roots, endpoint, UID, and native attestor.
   * @param signal - cancellation that destroys the connection.
   * @returns authenticated Main-only Host client.
   */
  static async connect(options: UnixHostClientOptions, signal?: AbortSignal): Promise<UnixHostClient> {
    const socket = createConnection(options.socketPath)
    await UnixHostClient.waitForConnection(socket, signal)
    try {
      const peer = await options.attestPeer(socket)
      if (peer.uid !== options.expectedUid || peer.executableSignatureDigest !== options.trustedExecutableSignatureDigest) {
        throw new HostAuthorityError('unavailable')
      }
      return await UnixHostClient.authenticate(socket, options, signal)
    } catch (error) {
      socket.destroy()
      throw error
    }
  }

  /**
   * Connect a protected Windows named pipe after its derived path was checked by the caller.
   * The Host's installation key signs a fresh challenge; the server separately attests the
   * connected Desktop daemon before it accepts any request.
   * @param options - Registration trust anchors and the already checked pipe path.
   * @param signal - Optional cancellation for connection and authentication.
   * @param connectSocket - Pipe connector; the client takes ownership of its socket.
   * @returns Authenticated client; authentication failure destroys the socket and rejects.
   */
  static async connectNamedPipe(
    options: Omit<UnixHostClientOptions, 'expectedUid' | 'attestPeer'>,
    signal?: AbortSignal,
    connectSocket: (path: string) => Socket = createConnection,
  ): Promise<UnixHostClient> {
    const socket = connectSocket(options.socketPath)
    await UnixHostClient.waitForConnection(socket, signal)
    try {
      return await UnixHostClient.authenticate(socket, options, signal)
    } catch (error) {
      socket.destroy()
      throw error
    }
  }

  /**
   * Authenticate an already peer-attested non-socket carrier.
   * @internal
   * @param options - Installation trust anchors used to verify the signed challenge.
   * @param transport - Attested carrier whose lifetime is transferred to the client.
   * @param signal - Optional authentication cancellation.
   * @returns Authenticated client; failure closes the transferred carrier and rejects.
   */
  static async connectAuthenticatedTransport(
    options: Omit<UnixHostClientOptions, 'expectedUid' | 'attestPeer' | 'socketPath'>,
    transport: HostClientFrameTransport,
    signal?: AbortSignal,
  ): Promise<UnixHostClient> {
    try {
      return await UnixHostClient.authenticateTransport(transport, options, signal)
    } catch (error) {
      transport.close()
      throw error
    }
  }

  private static waitForConnection(socket: Socket, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        socket.removeListener('connect', connected)
        socket.removeListener('error', failed)
        socket.destroy()
        reject(errorReason(signal?.reason))
      }
      const connected = (): void => {
        signal?.removeEventListener('abort', abort)
        socket.removeListener('error', failed)
        resolve()
      }
      const failed = (error: Error): void => {
        signal?.removeEventListener('abort', abort)
        socket.removeListener('connect', connected)
        socket.destroy()
        reject(error)
      }
      if (signal?.aborted) { abort(); return }
      socket.once('connect', connected)
      socket.once('error', failed)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private static async authenticate(
    socket: Socket,
    options: Omit<UnixHostClientOptions, 'expectedUid' | 'attestPeer'>,
    signal?: AbortSignal,
  ): Promise<UnixHostClient> {
    const channel = new FrameChannel(socket)
    return await UnixHostClient.authenticateTransport(channel, options, signal)
  }

  private static async authenticateTransport(
    channel: HostClientFrameTransport,
    options: Omit<UnixHostClientOptions, 'expectedUid' | 'attestPeer' | 'socketPath'>,
    signal?: AbortSignal,
  ): Promise<UnixHostClient> {
    const clientInstanceId = randomUUID() as HostControlClientInstanceId
    const request: HostInspectRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'host.inspect',
      params: { challenge: nonce(), client_instance_id: clientInstanceId, supported_versions: [1] },
    }
    const frame = await channel.call(request, signal)
    if (frame.type !== 'result' || frame.method !== 'host.inspect') {
      channel.close()
      throw new HostAuthorityError('unavailable')
    }
    if (frame.result.installation_id !== options.trustedInstallationId
      || frame.result.installation_public_key !== options.trustedInstallationPublicKey
      || frame.result.executable_signature_digest !== options.trustedExecutableSignatureDigest) {
      channel.close(); throw new HostAuthorityError('unavailable')
    }
    const trustedPublicKey = publicKeyObject(options.trustedInstallationPublicKey)
    if (!verify(
      null,
      encodeHostInspectSignaturePayload(request, frame),
      trustedPublicKey,
      Buffer.from(frame.result.challenge_signature, 'base64url'),
    )) {
      channel.close(); throw new HostAuthorityError('unavailable')
    }
    return new UnixHostClient(channel, {
      clientInstanceId,
      hostInstanceId: frame.result.host_instance_id,
      processNonce: frame.result.process_nonce,
    }, options.now ?? Date.now, frame.result)
  }

  /**
   * Report only local transport liveness; authority is still rechecked by every operation.
   * @returns Whether the local channel remains connected, not whether a Profile is authorized.
   */
  isConnected(): boolean { return this.channel.isConnected() }

  /**
   * Read Profile status over the authenticated Host process generation.
   * @param input - opaque binding plus optional cancellation.
   * @returns Profile availability without secrets.
   */
  async getProfileStatus(input: AccountBindingInput & {
    readonly signal?: AbortSignal
  }): Promise<{ state: 'ready' | 'unbound' | 'locked'; profileId?: string; persistenceGeneration?: number }> {
    const request: ProfileStatusRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'profile.status',
      params: this.accountBindingParams(input),
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== 'profile.status') throw new HostAuthorityError('unavailable')
    return frame.result.state === 'ready' ? {
      state: 'ready', profileId: frame.result.profile_id,
      persistenceGeneration: frame.result.persistence_generation,
    } : { state: frame.result.state }
  }

  /**
   * Inspect Main-vault handles for recoverable offline Account Profiles.
   * Runtime and schema expectations are pinned to the attested Host inspection.
   * @param input - bounded opaque key handles and optional cancellation.
   * @returns anonymous preflight candidates without Profile ids or handles.
   */
  async inspectOfflineAccountProfiles(input: {
    readonly profileKeyHandles: readonly string[]
    readonly signal?: AbortSignal
  }): Promise<{ readonly candidates: readonly {
    readonly state: 'recoverable' | 'compatibility_blocked'
    readonly candidateId: string
    readonly profileKind: 'account'
    readonly bindingCount: number
    readonly persistenceGeneration: number
    readonly sessionCount: number
    readonly pluginCount: number
    readonly compatibility: 'current' | 'legacy_runtime_required' | 'read_only_export_only'
    readonly preflightDigest: string
    readonly reasonCode?: string
  }[] }> {
    if (!this.inspection.capabilities.includes('profile.recovery_inspect' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileRecoveryInspectRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.recovery_inspect',
      params: {
        ...this.auth(), profile_key_handles: input.profileKeyHandles,
        expected_runtime_generation: this.inspection.runtime_generation,
        expected_schema_generation: this.inspection.schema_generation,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { candidates: frame.result.candidates.map(candidate => ({
      state: candidate.state, candidateId: candidate.candidate_id, profileKind: candidate.profile_kind,
      bindingCount: candidate.binding_count, persistenceGeneration: candidate.persistence_generation,
      sessionCount: candidate.session_count, pluginCount: candidate.plugin_count,
      compatibility: candidate.compatibility, preflightDigest: candidate.preflight_digest,
      ...(candidate.reason_code === undefined ? {} : { reasonCode: candidate.reason_code }),
    })) }
  }

  /**
   * Confirm one inspected Account Profile and acquire an offline-only selector.
   * @param input - candidate proof, idempotency id, and ephemeral Main-vault material.
   * @returns offline selector and generation facts after worker readiness.
   */
  async recoverOfflineAccountProfile(input: {
    readonly profileKeyHandle: string
    readonly profileUnlockMaterial: string
    readonly recoveryOperationId: string
    readonly candidateId: string
    readonly preflightDigest: string
    readonly signal?: AbortSignal
  }): Promise<{
    readonly state: 'offline_ready'
    readonly profileSelector: string
    readonly accessScope: 'offline_local'
    readonly persistenceGeneration: number
    readonly runtimeGeneration: number
  }> {
    if (!this.inspection.capabilities.includes('profile.recover_offline_account' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileRecoverOfflineAccountRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.recover_offline_account',
      params: {
        ...this.auth(), profile_key_handle: input.profileKeyHandle,
        profile_unlock_material: input.profileUnlockMaterial,
        recovery_operation_id: input.recoveryOperationId as never,
        candidate_id: input.candidateId as never, preflight_digest: input.preflightDigest as never,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return {
      state: frame.result.state, profileSelector: frame.result.profile_selector,
      accessScope: frame.result.access_scope, persistenceGeneration: frame.result.persistence_generation,
      runtimeGeneration: frame.result.runtime_generation,
    }
  }

  /**
   * Query one recovery operation without starting another worker.
   * @param input - operation id and optional cancellation.
   * @returns stable process-local recovery state.
   */
  async getOfflineAccountRecoveryStatus(input: {
    readonly recoveryOperationId: string
    readonly signal?: AbortSignal
  }): Promise<
    | { readonly state: 'recovering' | 'offline_ready' | 'unknown' }
    | { readonly state: 'failed'; readonly reasonCode: 'recovery_worker_failed' }
  > {
    if (!this.inspection.capabilities.includes('profile.recovery_status' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileRecoveryStatusRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.recovery_status',
      params: { ...this.auth(), recovery_operation_id: input.recoveryOperationId as never },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return frame.result.state === 'failed'
      ? { state: 'failed', reasonCode: frame.result.reason_code }
      : { state: frame.result.state }
  }

  /**
   * Open one recovered Account Profile through an offline-domain selector.
   * @param input - offline selector and optional cancellation.
   * @returns offline-scoped generation-fenced view lease.
   */
  async openOfflineAccountProfile(input: {
    readonly profileSelector: string
    readonly signal?: AbortSignal
  }): Promise<OfflineProfileOpenResult> {
    if (!this.inspection.capabilities.includes('profile.open_offline_account' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileOpenOfflineAccountRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.open_offline_account',
      params: { ...this.auth(), profile_selector: input.profileSelector },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { ...openProfileResult(frame.result), accessScope: frame.result.access_scope }
  }

  /**
   * Ensure one account Profile using Main-only identity and secure-store handles.
   * @param input - Account token and identity, binding, Keychain handle, and optional cancellation.
   * @returns ready opaque Profile id.
   */
  async ensureAccountProfile(input: AccountBindingInput & {
    readonly issuer: string
    readonly subject: string
    readonly accountAccessToken: string
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly profileId: string; readonly profileSelector: string }> {
    if (!this.inspection.capabilities.includes('profile.ensure_account_token' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileEnsureRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.ensure',
      params: {
        ...this.accountBindingParams(input),
        account_access_token: input.accountAccessToken,
        account_issuer: input.issuer, account_subject: input.subject, profile_key_handle: input.keyHandle,
        profile_unlock_material: input.unlockMaterial,
      },
    }
    return this.callReadyProfile(request, input.signal)
  }

  /**
   * Restore one offline Profile using a Host-signed selector and Main-vault key handle.
   * @param input - selector, key handle, unlock material, and cancellation signal.
   * @returns restored Profile id and refreshed selector.
   */
  async restoreProfile(input: AccountBindingInput & {
    readonly profileSelector: string
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly profileId: string; readonly profileSelector: string }> {
    const request: ProfileRestoreRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.restore',
      params: {
        ...this.accountBindingParams(input),
        profile_selector: input.profileSelector, profile_key_handle: input.keyHandle,
        profile_unlock_material: input.unlockMaterial,
      },
    }
    return this.callReadyProfile(request, input.signal)
  }

  /**
   * Bootstrap one account-independent local Profile using only Main-vault material.
   * @param input - Opaque vault handle, unlock material, and optional connection cancellation.
   * @returns Profile selector and persistence generation; rejects absent Host capability before sending.
   */
  async bootstrapLocalProfile(input: ProfileUnlockInput): Promise<{
    readonly profileId: string
    readonly profileSelector: string
    readonly persistenceGeneration: number
  }> {
    if (!this.inspection.capabilities.includes('profile.bootstrap_local' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileBootstrapLocalRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.bootstrap_local',
      params: this.profileUnlockParams(input),
    }
    return this.callLocalReadyProfile(request, input.signal)
  }

  /**
   * Restore one local-only Profile selected by its Host-signed selector.
   * @param input - Signed selector, matching vault proof, and optional connection cancellation.
   * @returns Restored Profile selector and persistence generation; Host rejection is propagated.
   */
  async restoreLocalProfile(input: ProfileUnlockInput & {
    readonly profileSelector: string
  }): Promise<{ readonly profileId: string; readonly profileSelector: string; readonly persistenceGeneration: number }> {
    const request: ProfileRestoreLocalRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.restore_local',
      params: {
        ...this.auth(), profile_selector: input.profileSelector,
        profile_key_handle: input.keyHandle, profile_unlock_material: input.unlockMaterial,
      },
    }
    return this.callLocalReadyProfile(request, input.signal)
  }

  /**
   * Open one Main-only view lease; abort destroys the connection and revokes all its leases.
   * @param input - opaque binding plus optional cancellation.
   * @returns generation-fenced Profile lease.
   */
  async openProfile(input: AccountBindingInput & {
    readonly signal?: AbortSignal
  }): Promise<ProfileOpenResult> {
    const request: ProfileOpenRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'profile.open',
      params: this.accountBindingParams(input),
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== 'profile.open') throw new HostAuthorityError('unavailable')
    return openProfileResult(frame.result)
  }

  /**
   * Open one previously unlocked local-only Profile through its signed selector.
   * @param input - Signed selector and optional cancellation, which revokes this connection's leases.
   * @returns Generation-fenced view lease; rejects if this connection has not unlocked the Profile.
   */
  async openLocalProfile(input: { readonly profileSelector: string; readonly signal?: AbortSignal }): Promise<ProfileOpenResult> {
    const request: ProfileOpenLocalRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.open_local',
      params: { ...this.auth(), profile_selector: input.profileSelector },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return openProfileResult(frame.result)
  }

  /**
   * Consume one connection-bound activation and obtain its Host-verified loopback origin.
   * @param input - Profile, lease, activation capability, generation fences, and optional cancellation.
   * @returns exact loopback origin plus activation generation and expiry.
   */
  async activateView(input: {
    readonly profileId: string
    readonly viewLeaseId: string
    readonly viewActivationHandle: string
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly signal?: AbortSignal
  }): Promise<{
    readonly origin: string
    readonly activationGeneration: number
    readonly expiresAt: number
    readonly bootstrapCookie: { readonly name: string; readonly value: string }
  }> {
    const request: ProfileViewActivateRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.view_activate',
      params: {
        ...this.auth(), profile_id: input.profileId as never, view_lease_id: input.viewLeaseId as never,
        view_activation_handle: input.viewActivationHandle as never,
        lease_generation: input.leaseGeneration, runtime_generation: input.runtimeGeneration,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return {
      origin: frame.result.origin,
      activationGeneration: frame.result.activation_generation,
      expiresAt: frame.result.expires_at,
      bootstrapCookie: frame.result.bootstrap_cookie,
    }
  }

  /**
   * Invoke the current Account Profile's default model using a token-verified connection grant.
   * @param input - current Account binding, bounded text, and optional cancellation signal.
   * @returns bounded text with model identity, or a classified failure.
   */
  async generateModelText(input: {
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
    readonly text: string
    readonly signal?: AbortSignal
  }): Promise<ProfileModelTextResult['result']> {
    if (!this.inspection.capabilities.includes('profile.model_text' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileModelTextRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.model_text',
      params: { ...this.auth(), authority_environment_id: input.authorityEnvironmentId as never,
        account_binding_handle: input.accountBindingHandle as never,
        authority_binding_version: input.authorityBindingVersion,
        text: input.text },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return frame.result
  }

  /**
   * Execute a negotiated extension command using a Main-held lease; no target paths cross the socket.
   * @param input - lease, runtime generation, bounded command and optional cancellation.
   * @returns a prepared plan, sanitized inventory or durable receipt; old Hosts reject before mutation.
   */
  async extensions(input: {
    readonly viewLeaseId: string
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly command: HostExtensionCommand
    readonly signal?: AbortSignal
  }): Promise<HostExtensionResponse> {
    if (!this.inspection.capabilities.includes('profile.extensions' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileExtensionsRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.extensions', params: {
        ...this.auth(), view_lease_id: input.viewLeaseId as never, lease_generation: input.leaseGeneration,
        runtime_generation: input.runtimeGeneration, command: input.command,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== 'profile.extensions') throw new HostAuthorityError('unavailable')
    return frame.result
  }

  /**
   * Execute one bounded mobile session command through the lease-selected Profile.
   * @param input - live view lease, closed command union, and optional cancellation.
   * @returns bounded JSON produced by the Profile worker executor.
   */
  async remoteSession(input: {
    readonly viewLeaseId: string
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly command: HostRemoteSessionCommand
    readonly signal?: AbortSignal
  }): Promise<HostRemoteSessionJson> {
    if (!this.inspection.capabilities.includes('profile.remote_session' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileRemoteSessionRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.remote_session', params: {
        ...this.auth(), view_lease_id: input.viewLeaseId as never, lease_generation: input.leaseGeneration,
        runtime_generation: input.runtimeGeneration, command: input.command,
      },
    }
    return this.remoteProfileValue(request, input.signal)
  }

  /**
   * Execute one bounded read through the lease-selected Profile worker.
   * @param input - Live view lease, exact read endpoint, arguments, and cancellation.
   * @returns A JSON projection small enough for the control frame.
   */
  async remoteUiRead(input: {
    readonly viewLeaseId: string
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly endpoint: ProfileRemoteUiReadRequest['params']['endpoint']
    readonly payload: ProfileRemoteUiReadRequest['params']['payload']
    readonly signal?: AbortSignal
  }): Promise<HostRemoteSessionJson> {
    if (!this.inspection.capabilities.includes('profile.remote_ui_read' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileRemoteUiReadRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.remote_ui_read', params: {
        ...this.auth(), view_lease_id: input.viewLeaseId as never, lease_generation: input.leaseGeneration,
        runtime_generation: input.runtimeGeneration, endpoint: input.endpoint, payload: input.payload,
      },
    }
    return this.remoteProfileValue(request, input.signal)
  }

  /**
   * Control a connection-owned native Session-follow cursor using short, lease-checked RPCs.
   * @param input - Live view lease, exact stream command, and optional cancellation.
   * @returns One bounded chunk, idle state, or terminal state without worker details.
   */
  async remoteUiStream(input: {
    readonly viewLeaseId: string
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly command: ProfileRemoteUiStreamRequest['params']['command']
    readonly signal?: AbortSignal
  }): Promise<ProfileRemoteUiStreamResult['result']> {
    if (!this.inspection.capabilities.includes('profile.remote_ui_stream' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileRemoteUiStreamRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.remote_ui_stream', params: {
        ...this.auth(), view_lease_id: input.viewLeaseId as never, lease_generation: input.leaseGeneration,
        runtime_generation: input.runtimeGeneration, command: input.command,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return frame.result
  }

  private async remoteProfileValue(
    request: ProfileRemoteSessionRequest | ProfileRemoteUiReadRequest, signal?: AbortSignal,
  ): Promise<HostRemoteSessionJson> {
    const frame = await this.call(request, signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return frame.result.value
  }

  /**
   * Inspect redacted legacy model candidates using a token-verified Account view.
   * @param input - Main-held view lease and optional cancellation.
   * @returns source digest and candidate metadata without credentials or paths.
   */
  async modelClaimInventory(input: {
    readonly viewLeaseId: string
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly signal?: AbortSignal
  }): Promise<LegacyModelClaimInventory> {
    if (!this.inspection.capabilities.includes('profile.model_claim_inventory' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileModelClaimInventoryRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.model_claim_inventory',
      params: { ...this.auth(), view_lease_id: input.viewLeaseId as never,
        lease_generation: input.leaseGeneration, runtime_generation: input.runtimeGeneration },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return {
      sourceDigest: frame.result.source_digest,
      candidates: frame.result.candidates.map(candidate => ({
        id: candidate.id, provider: candidate.provider, kind: candidate.kind,
        credential: candidate.credential, sharedCredential: candidate.shared_credential,
      })),
      unsupportedSettings: frame.result.unsupported_settings,
      unassignedCredentialReferences: frame.result.unassigned_credential_references,
      unassignedCredentialRecords: frame.result.unassigned_credential_records,
    }
  }

  /**
   * Confirm one candidate against the current source and Account view for at most one minute.
   * @param input - Account view, selected candidate and displayed source digest.
   * @returns One-use confirmation and operation id; no credential data.
   */
  async confirmModelClaim(input: {
    readonly viewLeaseId: string
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly candidateId: string
    readonly sourceDigest: string
    readonly signal?: AbortSignal
  }): Promise<{ confirmation: string; operationId: string; expiresAt: number }> {
    if (!this.inspection.capabilities.includes('profile.model_claim_confirm' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileModelClaimConfirmRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.model_claim_confirm',
      params: { ...this.auth(), view_lease_id: input.viewLeaseId as never,
        lease_generation: input.leaseGeneration, runtime_generation: input.runtimeGeneration,
        candidate_id: input.candidateId, source_digest: input.sourceDigest as HostControlSha256 },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { confirmation: frame.result.confirmation, operationId: frame.result.operation_id,
      expiresAt: frame.result.expires_at }
  }

  /**
   * Consume a one-use confirmation on this Host connection and commit its provider.
   * @param input - Confirmation returned by confirmModelClaim and optional cancellation.
   * @returns Redacted claim outcome.
   */
  async applyModelClaim(input: { readonly confirmation: string; readonly signal?: AbortSignal }): Promise<LegacyClaimOutcome> {
    if (!this.inspection.capabilities.includes('profile.model_claim_apply' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileModelClaimApplyRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.model_claim_apply',
      params: { ...this.auth(), confirmation: input.confirmation },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { state: frame.result.state, cleanupPending: frame.result.cleanup_pending }
  }

  /**
   * Read only this Account's durable claim receipt without starting a pending worker.
   * @param input - Fresh Account token, current binding, vault proof and candidate id.
   * @returns Secret-free receipt, or null when this Account has no active claim.
   */
  async modelClaimRecoveryStatus(input: ModelClaimRecoveryInput): Promise<LegacyClaimReceipt | null> {
    if (!this.inspection.capabilities.includes('profile.model_claim_recovery_status' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileModelClaimRecoveryStatusRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.model_claim_recovery_status',
      params: { ...this.modelClaimRecoveryParams(input), candidate_id: input.candidateId },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return frame.result.state === 'unclaimed' ? null : {
      candidateId: frame.result.candidate_id, operationId: frame.result.operation_id,
      sourceDigest: frame.result.source_digest, status: frame.result.state,
    }
  }

  /**
   * Discover same-Account unfinished claims without requiring a running Profile worker.
   * @param input - Current Account token, binding, and matching Main-vault proof.
   * @returns Bounded receipts without credentials or source paths.
   */
  async modelClaimRecoveryInventory(input: Omit<ModelClaimRecoveryInput, 'candidateId'>): Promise<readonly LegacyClaimReceipt[]> {
    if (!this.inspection.capabilities.includes('profile.model_claim_recovery_inventory' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileModelClaimRecoveryInventoryRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.model_claim_recovery_inventory',
      params: this.modelClaimRecoveryParams(input),
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return frame.result.receipts.map(receipt => ({
      candidateId: receipt.candidate_id, operationId: receipt.operation_id,
      sourceDigest: receipt.source_digest, status: receipt.state,
    }))
  }

  /**
   * Restore an interrupted claim from its durable preimage after rechecking Account ownership.
   * @param input - Recovery proof and exact operation id returned by status.
   * @returns Redacted restored outcome.
   */
  async restoreModelClaim(input: ModelClaimRecoveryInput & { readonly operationId: string }): Promise<LegacyClaimOutcome> {
    if (!this.inspection.capabilities.includes('profile.model_claim_restore' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileModelClaimRestoreRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.model_claim_restore',
      params: { ...this.modelClaimRecoveryParams(input), candidate_id: input.candidateId,
        operation_id: input.operationId },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { state: frame.result.state, cleanupPending: frame.result.cleanup_pending }
  }

  /**
   * Resume an already reserved claim after rechecking its same-Account recovery proof.
   * @param input - Recovery proof and exact operation and source digest from status.
   * @returns Redacted committed outcome.
   */
  async retryModelClaim(input: ModelClaimRecoveryInput & {
    readonly operationId: string
    readonly sourceDigest: string
  }): Promise<LegacyClaimOutcome> {
    if (!this.inspection.capabilities.includes('profile.model_claim_retry' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: ProfileModelClaimRetryRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.model_claim_retry',
      params: { ...this.modelClaimRecoveryParams(input), candidate_id: input.candidateId,
        operation_id: input.operationId,
        source_digest: input.sourceDigest as HostControlSha256 },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { state: frame.result.state, cleanupPending: frame.result.cleanup_pending }
  }

  private modelClaimRecoveryParams(input: Omit<ModelClaimRecoveryInput, 'candidateId'>):
  ProfileModelClaimRecoveryInventoryRequest['params'] {
    return { ...this.auth(), account_access_token: input.accountAccessToken,
      account_issuer: input.issuer, account_subject: input.subject,
      authority_environment_id: input.authorityEnvironmentId as never,
      account_binding_handle: input.accountBindingHandle,
      authority_binding_version: input.authorityBindingVersion,
      profile_key_handle: input.keyHandle, profile_unlock_material: input.unlockMaterial }
  }

  /**
   * Close one view lease on the connection that minted it.
   * @param input - lease identity, generations, and optional cancellation.
   */
  async closeViewLease(input: {
    readonly viewLeaseId: string
    readonly leaseGeneration: number
    readonly runtimeGeneration: number
    readonly signal?: AbortSignal
  }): Promise<void> {
    const request: ProfileLeaseCloseRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'profile.lease_close',
      params: {
        ...this.auth(),
        view_lease_id: input.viewLeaseId as never,
        lease_generation: input.leaseGeneration,
        runtime_generation: input.runtimeGeneration,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== 'profile.lease_close') throw new HostAuthorityError('unavailable')
  }

  /**
   * Read one source-Profile-scoped logical inventory proof before export.
   * @param input - source selector, optional legacy authority, and cancellation signal.
   * @returns bounded inventory proof for a subsequent begin call.
   */
  async getMigrationExportInventory(input: {
    readonly sourceProfileSelector: string
    readonly sourceInventoryAuthority?: string
    readonly signal?: AbortSignal
  }): Promise<MigrationExportInventoryProof> {
    const request: MigrationExportInventoryRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'migration.export_snapshot.inventory',
      params: {
        ...this.auth(), source_profile_selector: input.sourceProfileSelector,
        ...(input.sourceInventoryAuthority === undefined
          ? {} : { source_inventory_authority: input.sourceInventoryAuthority as never }),
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return {
      inventoryDigest: frame.result.inventory_digest,
      sourceGeneration: frame.result.source_generation,
      schemaVersion: frame.result.schema_version,
      requiredMaxRecords: frame.result.required_max_records,
      requiredMaxBytes: frame.result.required_max_bytes,
    }
  }

  /**
   * Probe the fixed owner-local legacy source and mint a connection-bound short-lived authority.
   * @param input - target Profile selector and cancellation signal.
   * @returns inventory proof, opaque authority, and authority expiry.
   */
  async getExistingMigrationSourceInventory(input: {
    readonly targetProfileSelector: string
    readonly signal?: AbortSignal
  }): Promise<MigrationExportInventoryProof & {
    readonly sourceInventoryAuthority: string
    readonly sourceInstallationId: string
    readonly expiresAt: number
  }> {
    const request: MigrationExistingSourceInventoryRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'migration.existing_source.inventory',
      params: { ...this.auth(), target_profile_selector: input.targetProfileSelector },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return {
      sourceInventoryAuthority: frame.result.source_inventory_authority,
      sourceInstallationId: frame.result.source_installation_id,
      expiresAt: frame.result.expires_at,
      inventoryDigest: frame.result.inventory_digest,
      sourceGeneration: frame.result.source_generation,
      schemaVersion: frame.result.schema_version,
      requiredMaxRecords: frame.result.required_max_records,
      requiredMaxBytes: frame.result.required_max_bytes,
    }
  }

  /**
   * Begin one owner-connection-bound schema-aware semantic migration export.
   * @param input - inventory proof, hard bounds, and optional cancellation.
   * @returns stable export receipt and semantic digest.
   */
  async beginMigrationExport(input: MigrationExportBeginInput & {
    readonly sourceProfileSelector: string
    readonly sourceInventoryAuthority?: string
    readonly signal?: AbortSignal
  }): Promise<MigrationExportReceipt> {
    const request: MigrationExportBeginRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'migration.export_snapshot.begin',
      params: {
        ...this.auth(),
        source_profile_selector: input.sourceProfileSelector,
        ...(input.sourceInventoryAuthority === undefined
          ? {} : { source_inventory_authority: input.sourceInventoryAuthority as never }),
        expected_inventory_digest: input.expectedInventoryDigest as never,
        max_records: input.maxRecords,
        max_bytes: input.maxBytes,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return {
      exportId: frame.result.export_id,
      transferId: frame.result.transfer_id,
      transferDigest: frame.result.transfer_digest,
      schemaVersion: frame.result.schema_version,
      sourceGeneration: frame.result.source_generation,
      recordCount: frame.result.record_count,
      firstEventSequence: frame.result.first_event_sequence,
      lastEventSequence: frame.result.last_event_sequence,
      semanticDigest: frame.result.semantic_digest,
      chunkCount: frame.result.chunk_count,
    }
  }

  /**
   * Read one idempotent digest-only semantic export chunk.
   * @param input - export id, zero-based chunk index, and optional cancellation.
   * @returns immutable digest-only export chunk.
   */
  async readMigrationExport(input: MigrationExportReadInput & {
    readonly sourceProfileSelector: string
    readonly sourceInventoryAuthority?: string
    readonly signal?: AbortSignal
  }): Promise<MigrationExportChunk> {
    const request: MigrationExportReadRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'migration.export_snapshot.read',
      params: {
        ...this.auth(),
        source_profile_selector: input.sourceProfileSelector,
        ...(input.sourceInventoryAuthority === undefined
          ? {} : { source_inventory_authority: input.sourceInventoryAuthority as never }),
        export_id: input.exportId,
        chunk_index: input.chunkIndex,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return {
      exportId: frame.result.export_id,
      chunkIndex: frame.result.chunk_index,
      records: frame.result.records.map(record => ({
        collection: record.collection,
        id: record.id,
        ...(record.session_id === undefined ? {} : { sessionId: record.session_id }),
        sequence: record.sequence,
        payloadDigest: record.payload_digest,
      })),
      chunkDigest: frame.result.chunk_digest,
      final: frame.result.final,
    }
  }

  /**
   * Stage an owner-only migration transfer into an inactive generation.
   * @param input - transfer proof, source identity, target selector, bounds, and signal.
   * @returns durable import id and stage version.
   */
  async stageMigrationImport(input: {
    readonly transferId: string
    readonly transferDigest: string
    readonly sourceInstallationId: string
    readonly sourceInventoryDigest: string
    readonly sourceGeneration: string
    readonly sourceSchemaVersion: number
    readonly targetGeneration: number
    readonly recordCount: number
    readonly semanticDigest: string
    readonly targetProfileSelector: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly importId: string; readonly stageVersion: number }> {
    const request: MigrationImportStageRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'migration.import_snapshot.stage',
      params: {
        ...this.auth(), transfer_id: input.transferId as never, transfer_digest: input.transferDigest as never,
        source_installation_id: input.sourceInstallationId as never,
        source_inventory_digest: input.sourceInventoryDigest as never, source_generation: input.sourceGeneration as never,
        source_schema_version: input.sourceSchemaVersion, target_generation: input.targetGeneration,
        target_profile_selector: input.targetProfileSelector,
        record_count: input.recordCount, semantic_digest: input.semanticDigest as never,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { importId: frame.result.import_id, stageVersion: frame.result.stage_version }
  }

  /**
   * Recover the durable import stage after a lost RPC response.
   * @param input - transfer identity, target generation and selector, and signal.
   * @returns durable import identity, version, and state.
   */
  async getMigrationImportStatus(input: {
    readonly transferId: string
    readonly targetGeneration: number
    readonly sourceInstallationId: string
    readonly targetProfileSelector: string
    readonly signal?: AbortSignal
  }): Promise<{
    readonly importId: string
    readonly stageVersion: number
    readonly state: 'preparing' | 'staged' | 'verified' | 'committed' | 'aborted'
  }> {
    const request: MigrationImportStatusRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'migration.import_snapshot.status',
      params: {
        ...this.auth(), transfer_id: input.transferId as never, target_generation: input.targetGeneration,
        source_installation_id: input.sourceInstallationId as never,
        target_profile_selector: input.targetProfileSelector,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { importId: frame.result.import_id, stageVersion: frame.result.stage_version, state: frame.result.state }
  }

  /**
   * Verify one inactive migration generation through stage-version CAS.
   * @param input - import id, expected version, target selector, and signal.
   * @returns advanced stage version and semantic digest.
   */
  async verifyMigrationImport(input: {
    readonly importId: string
    readonly expectedStageVersion: number
    readonly targetProfileSelector: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly stageVersion: number; readonly semanticDigest: string }> {
    const request: MigrationImportVerifyRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'migration.import_snapshot.verify',
      params: this.migrationImportCasParams(input),
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { stageVersion: frame.result.stage_version, semanticDigest: frame.result.semantic_digest }
  }

  /**
   * Commit one verified migration generation through active-generation CAS.
   * @param input - import id, stage and active generation fences, selector, and signal.
   * @returns committed stage version and active generation.
   */
  async commitMigrationImport(input: {
    readonly importId: string
    readonly expectedStageVersion: number
    readonly expectedCurrentGeneration: number
    readonly targetProfileSelector: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly stageVersion: number; readonly activeGeneration: number }> {
    const request: MigrationImportCommitRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'migration.import_snapshot.commit',
      params: {
        ...this.auth(), import_id: input.importId as never, expected_stage_version: input.expectedStageVersion,
        expected_current_generation: input.expectedCurrentGeneration,
        target_profile_selector: input.targetProfileSelector,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { stageVersion: frame.result.stage_version, activeGeneration: frame.result.active_generation }
  }

  /**
   * Abort one uncommitted migration generation through stage-version CAS.
   * @param input - import id, expected version, target selector, and signal.
   * @returns aborted stage version.
   */
  async abortMigrationImport(input: {
    readonly importId: string
    readonly expectedStageVersion: number
    readonly targetProfileSelector: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly stageVersion: number }> {
    const request: MigrationImportAbortRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'migration.import_snapshot.abort',
      params: this.migrationImportCasParams(input),
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { stageVersion: frame.result.stage_version }
  }

  /** Close the local connection; Host revokes every lease it minted. */
  close(): void { this.channel.close() }

  private async callReadyProfile(
    request: ProfileEnsureRequest | ProfileRestoreRequest, signal?: AbortSignal,
  ): Promise<{ readonly profileId: string; readonly profileSelector: string }> {
    return this.call(request, signal).then((frame) => {
      if (frame.type !== 'result' || (frame.method !== 'profile.ensure' && frame.method !== 'profile.restore')
        || frame.method !== request.method) throw new HostAuthorityError('unavailable')
      return readyProfileResult(frame.result)
    })
  }

  private callLocalReadyProfile(
    request: ProfileBootstrapLocalRequest | ProfileRestoreLocalRequest, signal?: AbortSignal,
  ): Promise<{ readonly profileId: string; readonly profileSelector: string; readonly persistenceGeneration: number }> {
    return this.call(request, signal).then((frame) => {
      if (frame.type !== 'result' || (frame.method !== 'profile.bootstrap_local' && frame.method !== 'profile.restore_local')
        || frame.method !== request.method) throw new HostAuthorityError('unavailable')
      return localReadyProfileResult(frame.result)
    })
  }

  private profileUnlockParams(input: ProfileUnlockInput): ProfileBootstrapLocalRequest['params'] {
    return { ...this.auth(), profile_key_handle: input.keyHandle, profile_unlock_material: input.unlockMaterial }
  }

  private migrationImportCasParams(input: {
    readonly importId: string
    readonly expectedStageVersion: number
    readonly targetProfileSelector: string
  }): MigrationImportVerifyRequest['params'] {
    return {
      ...this.auth(),
      import_id: input.importId as never,
      expected_stage_version: input.expectedStageVersion,
      target_profile_selector: input.targetProfileSelector,
    }
  }

  private accountBindingParams(input: AccountBindingInput): ProfileStatusRequest['params'] {
    return {
      ...this.auth(),
      authority_environment_id: input.authorityEnvironmentId as never,
      account_binding_handle: input.accountBindingHandle as never,
      authority_binding_version: input.authorityBindingVersion,
    }
  }

  private auth(): Pick<
    ProfileStatusRequest['params'],
    'client_instance_id' | 'host_instance_id' | 'process_nonce' | 'jti' | 'issued_at' | 'expires_at'
  > {
    const issuedAt = this.now()
    return {
      client_instance_id: this.state.clientInstanceId,
      host_instance_id: this.state.hostInstanceId,
      process_nonce: this.state.processNonce,
      jti: randomUUID() as HostControlJti,
      issued_at: issuedAt,
      expires_at: issuedAt + 15_000,
    }
  }

  private async call(
    request: ProfileExtensionsRequest | ProfileRemoteSessionRequest | ProfileRemoteUiReadRequest
      | ProfileRemoteUiStreamRequest | ProfileModelClaimInventoryRequest
      | ProfileModelClaimConfirmRequest | ProfileModelClaimApplyRequest
      | ProfileModelClaimRecoveryStatusRequest | ProfileModelClaimRestoreRequest
      | ProfileModelClaimRecoveryInventoryRequest
      | ProfileModelClaimRetryRequest
      | ProfileStatusRequest | ProfileEnsureRequest | ProfileRestoreRequest
      | ProfileBootstrapLocalRequest | ProfileRestoreLocalRequest
      | ProfileOpenRequest | ProfileOpenLocalRequest
      | ProfileRecoveryInspectRequest | ProfileRecoverOfflineAccountRequest
      | ProfileOpenOfflineAccountRequest | ProfileRecoveryStatusRequest
      | ProfileViewActivateRequest | ProfileModelTextRequest | ProfileLeaseCloseRequest
      | MigrationExistingSourceInventoryRequest
      | MigrationExportInventoryRequest | MigrationExportBeginRequest | MigrationExportReadRequest
      | MigrationImportStageRequest | MigrationImportStatusRequest | MigrationImportVerifyRequest
      | MigrationImportCommitRequest | MigrationImportAbortRequest,
    signal?: AbortSignal,
  ): Promise<HostControlFrame> {
    const frame = await this.channel.call(request, signal)
    if (frame.type === 'error') throw new HostAuthorityError(authorityCodeFromFrame(frame.error.code))
    return frame
  }
}

/**
 * Discover a Host only from an installation-registry-owned endpoint. Missing
 * or refused endpoints are `stopped`; every attestation/protocol ambiguity is
 * `unknown` and never downgraded to stopped.
 * @param options - registry-owned endpoint and installation trust roots.
 * @param signal - optional discovery cancellation.
 * @returns bounded running, stopped, or unknown state.
 */
export async function discoverUnixHost(
  options: UnixHostClientOptions & { readonly trustedEndpoint: true; readonly endpointRegistrationId: string },
  signal?: AbortSignal,
): Promise<UnixHostDiscovery> {
  try {
    const stat = lstatSync(options.socketPath)
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== options.expectedUid) {
      return { state: 'unknown', code: 'host_unverified' }
    }
  } catch (error) {
    const registrationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && registrationId.test(options.endpointRegistrationId)) {
      return { state: 'stopped', code: 'trusted_host_not_running' }
    }
    return { state: 'unknown', code: 'transport_unavailable' }
  }
  try {
    const client = await UnixHostClient.connect(options, signal)
    return { state: 'running', client, inspection: client.inspection }
  } catch {
    return { state: 'unknown', code: 'host_unverified' }
  }
}
