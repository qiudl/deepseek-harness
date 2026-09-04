import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type {
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
  HostAuthorizedParams,
  HostSessionAttachRequest,
  HostSessionDetachRequest,
  HostInstanceId,
  InstallationId,
  ProfileLeaseCloseRequest,
  ProfileEnsureRequest,
  ProfileRestoreRequest,
  ProfileOpenRequest,
  ProfileViewActivateRequest,
  ProfileStatusRequest,
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
import {
  HOST_CONTROL_MAX_FRAME_BYTES,
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostInspectSignaturePayload,
  migrationProfileSelectorHash,
} from '@deepseek-ai/dsh-host-control-protocol/src/index.ts'
import type { HostAuthorityErrorCode, PersonProfileId, ProfileOpenResult, ProfileViewLeaseId } from './types.ts'
import { HostAuthorityError } from './types.ts'
import type { DesktopHost } from './desktop-host.ts'
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
  readonly hostGeneration: number
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

interface HandshakeState {
  readonly clientInstanceId: HostControlClientInstanceId
  readonly hostInstanceId: HostInstanceId
  readonly hostGeneration: number
  readonly processNonce: HostControlNonce
}

const capabilities = [
  'host.inspect',
  'profile.lease_close',
  'profile.ensure',
  'profile.ensure_account_token',
  'profile.open',
  'profile.restore',
  'profile.status',
  'profile.view_activate',
  'session.attach',
  'session.detach',
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

function mintProfileSelector(identity: HostIdentity, profileId: string, bindingGeneration: number): string {
  const payload: ProfileSelectorPayload = {
    version: 1, installation_id: identity.installationId, profile_id: profileId, binding_generation: bindingGeneration,
    runtime_generation: identity.runtimeGeneration, schema_generation: identity.schemaGeneration,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = sign(null, Buffer.from(`dsh-profile-selector/v1\0${encoded}`), privateKeyObject(identity.installationPrivateKey))
    .toString('base64url')
  return `${encoded}.${signature}`
}

function verifyProfileSelector(identity: HostIdentity, selector: string): ProfileSelectorPayload {
  const [encoded, signature, extra] = selector.split('.')
  if (!encoded || !signature || extra !== undefined || !verify(
    null, Buffer.from(`dsh-profile-selector/v1\0${encoded}`), publicKeyObject(identity.installationPublicKey),
    Buffer.from(signature, 'base64url'),
  )) throw new HostAuthorityError('unauthorized')
  let payload: unknown
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown } catch {
    throw new HostAuthorityError('unauthorized')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new HostAuthorityError('unauthorized')
  const value = payload as Partial<ProfileSelectorPayload>
  if (Object.keys(value).join(',') !== 'version,installation_id,profile_id,binding_generation,runtime_generation,schema_generation'
    || value.version !== 1 || value.installation_id !== identity.installationId
    || typeof value.profile_id !== 'string' || !Number.isSafeInteger(value.binding_generation) || (value.binding_generation ?? 0) < 1
    || value.runtime_generation !== identity.runtimeGeneration || value.schema_generation !== identity.schemaGeneration) {
    throw new HostAuthorityError('stale')
  }
  return value as ProfileSelectorPayload
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
    error: { code, retryable: code === 'busy' || code === 'unavailable', correlation_id: randomUUID() as never },
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

class FrameChannel {
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

/** Post-inspection expiry, process-generation, and single-use JTI authority. */
export class HostRequestAuthorizer {
  private readonly consumed = new Map<HostControlJti, number>()
  constructor(private readonly state: HandshakeState, private readonly now: () => number) {}

  /**
   * Consume one request authorization tuple exactly once.
   * @param params - process-bound request identity, expiry, and JTI.
   */
  authorize(params: HostAuthorizedParams): void {
    const current = this.now()
    for (const [jti, expiry] of this.consumed) if (expiry <= current) this.consumed.delete(jti)
    if (params.client_instance_id !== this.state.clientInstanceId || params.host_instance_id !== this.state.hostInstanceId
      || params.host_generation !== this.state.hostGeneration
      || params.process_nonce !== this.state.processNonce) throw new HostAuthorityError('stale')
    if (params.issued_at >= params.expires_at || params.issued_at > current + 5_000 || params.issued_at < current - 30_000
      || params.expires_at <= current || params.expires_at - params.issued_at > 30_000) {
      throw new HostAuthorityError('stale')
    }
    if (this.consumed.has(params.jti)) throw new HostAuthorityError('replayed')
    this.consumed.set(params.jti, params.expires_at)
  }
}

/** Running owner-only UDS server. */
export class UnixHostServer {
  private server: Server | undefined
  private socketIdentity?: { dev: number; ino: number }
  private readonly connections = new Set<Socket>()
  private readonly sessions = new Map<string, {
    readonly environmentId: string
    readonly sessionGeneration: number
    readonly permissionEpoch: number
  }>()
  private readonly detachedSessions = new Map<string, {
    readonly environmentId: string
    readonly sessionGeneration: number
    readonly activeSessions: number
  }>()
  private readonly environmentPermissionEpochs = new Map<string, number>()
  constructor(private readonly options: UnixHostServerOptions) {}

  private attachSession(ownerId: string, request: HostSessionAttachRequest): number {
    this.options.ownership.assertOwner()
    const input = request.params
    if (input.client_protocol !== 1) throw new HostAuthorityError('upgrade_required')
    if (input.profile_format_generation !== this.options.identity.schemaGeneration) throw new HostAuthorityError('stale')
    const current = this.sessions.get(ownerId)
    const detached = this.detachedSessions.get(ownerId)
    const environmentPermissionEpoch = this.environmentPermissionEpochs.get(input.authority_environment_id)
    if (environmentPermissionEpoch !== undefined && input.permission_epoch < environmentPermissionEpoch) {
      throw new HostAuthorityError('stale')
    }
    if (!current && detached && (detached.environmentId !== input.authority_environment_id
      || input.session_generation <= detached.sessionGeneration)) throw new HostAuthorityError('stale')
    if (current) {
      if (current.environmentId !== input.authority_environment_id
        || input.session_generation < current.sessionGeneration
        || input.permission_epoch < current.permissionEpoch) throw new HostAuthorityError('stale')
      if (input.session_generation === current.sessionGeneration
        && input.permission_epoch !== current.permissionEpoch) throw new HostAuthorityError('conflict')
    }
    this.sessions.set(ownerId, {
      environmentId: input.authority_environment_id,
      sessionGeneration: input.session_generation,
      permissionEpoch: input.permission_epoch,
    })
    if (environmentPermissionEpoch === undefined || input.permission_epoch > environmentPermissionEpoch) {
      this.environmentPermissionEpochs.set(input.authority_environment_id, input.permission_epoch)
    }
    this.detachedSessions.delete(ownerId)
    return this.sessions.size
  }

  private detachSession(ownerId: string, request: HostSessionDetachRequest): number {
    this.options.ownership.assertOwner()
    const current = this.sessions.get(ownerId)
    if (!current) {
      const detached = this.detachedSessions.get(ownerId)
      if (detached?.environmentId === request.params.authority_environment_id
        && detached.sessionGeneration === request.params.session_generation) return detached.activeSessions
      throw new HostAuthorityError('stale')
    }
    if (current.environmentId !== request.params.authority_environment_id
      || current.sessionGeneration !== request.params.session_generation) throw new HostAuthorityError('stale')
    this.sessions.delete(ownerId)
    const activeSessions = this.sessions.size
    this.detachedSessions.set(ownerId, {
      environmentId: current.environmentId,
      sessionGeneration: current.sessionGeneration,
      activeSessions,
    })
    return activeSessions
  }

  /** Bind the UDS path after refusing link/regular-file substitution. */
  async start(): Promise<void> {
    if (this.server) throw new HostAuthorityError('conflict')
    if (this.options.identity.hostGeneration !== this.options.ownership.hostGeneration) {
      throw new HostAuthorityError('stale')
    }
    this.options.ownership.assertOwner()
    try {
      const stat = lstatSync(this.options.socketPath)
      if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== this.options.expectedUid) throw new HostAuthorityError('conflict')
      this.options.ownership.assertOwner()
      unlinkSync(this.options.socketPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const server = createServer((socket) => { void this.accept(socket) })
    this.server = server
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
  }

  /** Close connections and remove only the socket inode this server created. */
  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    for (const socket of this.connections) socket.destroy()
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
    const lifetime = new AbortController()
    this.connections.add(socket)
    socket.once('close', () => {
      lifetime.abort()
      this.connections.delete(socket)
      this.sessions.delete(ownerId)
      this.detachedSessions.delete(ownerId)
      this.options.host.revokeOwner(ownerId)
    })
    socket.pause()
    try {
      const peer = await this.options.attestPeer(socket)
      if (peer.uid !== this.options.expectedUid || !validSha256(peer.executableSignatureDigest)
        || !this.options.allowedDesktopExecutableDigests.has(peer.executableSignatureDigest)) {
        throw new HostAuthorityError('unauthorized')
      }
    } catch { socket.destroy(); return }
    let inspected = false
    let authorizer: HostRequestAuthorizer | undefined
    const migrationExports = new Map<string, MigrationExportService>()
    const legacyAuthorities = new Map<string, {
      readonly profileId: string
      readonly expiresAt: number
      readonly service: MigrationExportService
      readonly exportIds: Set<string>
    }>()
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
    const channel = new FrameChannel(socket, async (frame) => {
      if (frame.type !== 'request') { socket.destroy(); return }
      if (!inspected) {
        if (frame.method !== 'host.inspect') { socket.destroy(); return }
        const response = this.inspect(frame, migrationExportEnabled, migrationImportEnabled, legacyMigrationEnabled)
        inspected = true
        authorizer = new HostRequestAuthorizer({
          clientInstanceId: frame.params.client_instance_id,
          hostInstanceId: response.result.host_instance_id,
          hostGeneration: response.result.host_generation,
          processNonce: response.result.process_nonce,
        }, this.options.now ?? Date.now)
        channel.send(response)
        return
      }
      if (frame.method === 'host.inspect') { socket.destroy(); return }
      if (!authorizer) { socket.destroy(); return }
      try {
        authorizer.authorize(frame.params)
        if (frame.method !== 'session.attach' && frame.method !== 'session.detach'
          && !this.sessions.has(ownerId)) throw new HostAuthorityError('upgrade_required')
        const attachedSession = this.sessions.get(ownerId)
        if (frame.method !== 'session.attach' && frame.method !== 'session.detach'
          && attachedSession && attachedSession.permissionEpoch
          !== this.environmentPermissionEpochs.get(attachedSession.environmentId)) {
          throw new HostAuthorityError('stale')
        }
        if ('authority_environment_id' in frame.params && attachedSession
          && frame.params.authority_environment_id !== attachedSession.environmentId) {
          throw new HostAuthorityError('unauthorized')
        }
        if (frame.method === 'session.attach') {
          const activeSessions = this.attachSession(ownerId, frame)
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: 'session.attach',
            result: { attached: true, host_generation: this.options.identity.hostGeneration, active_sessions: activeSessions },
          })
        } else if (frame.method === 'session.detach') {
          const activeSessions = this.detachSession(ownerId, frame)
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: 'session.detach',
            result: { detached: true, host_generation: this.options.identity.hostGeneration, active_sessions: activeSessions },
          })
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
            const proof = await service.inventory(lifetime.signal)
            const authority = randomBytes(32).toString('base64url')
            const expiresAt = (this.options.now ?? Date.now)() + 60_000
            legacyAuthorities.set(authority, { profileId, expiresAt, service, exportIds: new Set() })
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              source_inventory_authority: authority as never,
              source_installation_id: this.options.identity.installationId as never,
              expires_at: expiresAt,
              inventory_digest: proof.inventoryDigest as never,
              source_generation: proof.sourceGeneration as never,
              schema_version: proof.schemaVersion,
              required_max_records: proof.requiredMaxRecords,
              required_max_bytes: proof.requiredMaxBytes,
            } })
          } catch (error) { channel.send(safeError(migrationCode(error), frame)) }
        } else if (frame.method === 'migration.export_snapshot.inventory') {
          try {
            const migrationExport = await migrationExportFor(
              frame.params.source_profile_selector, frame.params.source_inventory_authority,
            )
            const proof = await migrationExport.inventory(lifetime.signal)
            channel.send({ version: 1, type: 'result', request_id: frame.request_id, method: frame.method, result: {
              inventory_digest: proof.inventoryDigest as never,
              source_generation: proof.sourceGeneration as never,
              schema_version: proof.schemaVersion,
              required_max_records: proof.requiredMaxRecords,
              required_max_bytes: proof.requiredMaxBytes,
            } })
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
            }, lifetime.signal)
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
        } else if (frame.method === 'profile.ensure') {
          if (!frame.params.account_access_token) throw new HostAuthorityError('upgrade_required')
          const profile = await this.options.host.ensureAccountProfile({
            accountAccessToken: frame.params.account_access_token,
            issuer: frame.params.account_issuer, subject: frame.params.account_subject,
            authorityEnvironmentId: frame.params.authority_environment_id,
            accountBindingHandle: frame.params.account_binding_handle,
            authorityBindingVersion: frame.params.authority_binding_version,
            keyHandle: frame.params.profile_key_handle,
            unlockMaterial: frame.params.profile_unlock_material,
            ownerId,
          })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: {
              state: 'ready', profile_id: profile.profileId as never,
              profile_selector: mintProfileSelector(this.options.identity, profile.profileId, profile.bindingGeneration),
            },
          })
        } else if (frame.method === 'profile.restore') {
          const selector = verifyProfileSelector(this.options.identity, frame.params.profile_selector)
          const profile = await this.options.host.restoreProfile({
            profileId: selector.profile_id as never, bindingGeneration: selector.binding_generation,
            keyHandle: frame.params.profile_key_handle,
            unlockMaterial: frame.params.profile_unlock_material,
            ownerId,
          })
          channel.send({
            version: 1, type: 'result', request_id: frame.request_id, method: frame.method,
            result: {
              state: 'ready', profile_id: profile.profileId as never,
              profile_selector: mintProfileSelector(this.options.identity, profile.profileId, profile.bindingGeneration),
            },
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
            result: {
              profile_id: opened.profileId as never,
              view_lease_id: opened.viewLeaseId as never,
              view_activation_handle: opened.viewActivationHandle as never,
              lease_generation: opened.leaseGeneration,
              expires_at: opened.expiresAt,
              runtime_generation: opened.runtimeGeneration,
            },
          })
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
      } catch (error) { channel.send(safeError(authorityCode(error), frame)) }
    })
    socket.resume()
  }

  private inspect(
    request: HostInspectRequest,
    migrationExport: boolean,
    migrationImport: boolean,
    legacyMigration: boolean,
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
        host_generation: identity.hostGeneration,
        process_nonce: identity.processNonce as HostControlNonce,
        capabilities: [
          ...capabilities,
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

/** Connected Main-only SDK matching Slark's `DshPersonalHostAdapter`. */
export class UnixHostClient {
  private constructor(
    private readonly channel: FrameChannel,
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
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        socket.destroy()
        reject(errorReason(signal?.reason))
      }
      if (signal?.aborted) { abort(); return }
      socket.once('connect', () => { signal?.removeEventListener('abort', abort); resolve() })
      socket.once('error', reject)
      signal?.addEventListener('abort', abort, { once: true })
    })
    const peer = await options.attestPeer(socket)
    if (peer.uid !== options.expectedUid || peer.executableSignatureDigest !== options.trustedExecutableSignatureDigest) {
      socket.destroy(); throw new HostAuthorityError('unavailable')
    }
    const channel = new FrameChannel(socket)
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
      socket.destroy()
      throw new HostAuthorityError('unavailable')
    }
    if (frame.result.installation_id !== options.trustedInstallationId
      || frame.result.installation_public_key !== options.trustedInstallationPublicKey
      || frame.result.executable_signature_digest !== options.trustedExecutableSignatureDigest
      || !verify(
        null,
        encodeHostInspectSignaturePayload(request, frame),
        publicKeyObject(options.trustedInstallationPublicKey),
        Buffer.from(frame.result.challenge_signature, 'base64url'),
      )) {
      socket.destroy(); throw new HostAuthorityError('unavailable')
    }
    return new UnixHostClient(channel, {
      clientInstanceId,
      hostInstanceId: frame.result.host_instance_id,
      hostGeneration: frame.result.host_generation,
      processNonce: frame.result.process_nonce,
    }, options.now ?? Date.now, frame.result)
  }

  /** Attach this authenticated connection as one environment Session. */
  async attachEnvironmentSession(input: {
    readonly authorityEnvironmentId: string
    readonly sessionGeneration: number
    readonly permissionEpoch: number
    readonly clientProtocol: number
    readonly profileFormatGeneration: number
    readonly signal?: AbortSignal
  }): Promise<{ readonly hostGeneration: number; readonly activeSessions: number }> {
    if (!this.inspection.capabilities.includes('session.attach' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: HostSessionAttachRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'session.attach',
      params: {
        ...this.auth(),
        authority_environment_id: input.authorityEnvironmentId as never,
        session_generation: input.sessionGeneration,
        permission_epoch: input.permissionEpoch,
        client_protocol: input.clientProtocol,
        profile_format_generation: input.profileFormatGeneration,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { hostGeneration: frame.result.host_generation, activeSessions: frame.result.active_sessions }
  }

  /** Detach this connection's exact Session and report remaining active Sessions. */
  async detachEnvironmentSession(input: {
    readonly authorityEnvironmentId: string
    readonly sessionGeneration: number
    readonly signal?: AbortSignal
  }): Promise<{ readonly hostGeneration: number; readonly activeSessions: number }> {
    if (!this.inspection.capabilities.includes('session.detach' as HostControlCapability)) {
      throw new HostAuthorityError('upgrade_required')
    }
    const request: HostSessionDetachRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'session.detach',
      params: {
        ...this.auth(),
        authority_environment_id: input.authorityEnvironmentId as never,
        session_generation: input.sessionGeneration,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { hostGeneration: frame.result.host_generation, activeSessions: frame.result.active_sessions }
  }

  /**
   * Read Profile status over the authenticated Host process generation.
   * @param input - opaque binding plus optional cancellation.
   * @returns Profile availability without secrets.
   */
  async getProfileStatus(input: {
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
    readonly signal?: AbortSignal
  }): Promise<{ state: 'ready' | 'unbound' | 'locked'; profileId?: string; persistenceGeneration?: number }> {
    const request: ProfileStatusRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'profile.status',
      params: {
        ...this.auth(), authority_environment_id: input.authorityEnvironmentId as never,
        account_binding_handle: input.accountBindingHandle as never,
        authority_binding_version: input.authorityBindingVersion,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== 'profile.status') throw new HostAuthorityError('unavailable')
    return frame.result.state === 'ready' ? {
      state: 'ready', profileId: frame.result.profile_id,
      persistenceGeneration: frame.result.persistence_generation,
    } : { state: frame.result.state }
  }

  /**
   * Ensure one account Profile using Main-only identity and secure-store handles.
   * @param input - Account token and identity, binding, Keychain handle, and optional cancellation.
   * @returns ready opaque Profile id.
   */
  async ensureAccountProfile(input: {
    readonly issuer: string
    readonly subject: string
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
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
        ...this.auth(), authority_environment_id: input.authorityEnvironmentId as never,
        account_binding_handle: input.accountBindingHandle as never,
        authority_binding_version: input.authorityBindingVersion,
        account_access_token: input.accountAccessToken,
        account_issuer: input.issuer, account_subject: input.subject, profile_key_handle: input.keyHandle,
        profile_unlock_material: input.unlockMaterial,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { profileId: frame.result.profile_id, profileSelector: frame.result.profile_selector }
  }

  /**
   * Restore one offline Profile using a Host-signed selector and Main-vault key handle.
   * @param input - selector, key handle, unlock material, and cancellation signal.
   * @returns restored Profile id and refreshed selector.
   */
  async restoreProfile(input: {
    readonly profileSelector: string
    readonly keyHandle: string
    readonly unlockMaterial: string
    readonly signal?: AbortSignal
  }): Promise<{ readonly profileId: string; readonly profileSelector: string }> {
    const request: ProfileRestoreRequest = {
      version: 1, type: 'request', request_id: requestId(), method: 'profile.restore',
      params: {
        ...this.auth(), profile_selector: input.profileSelector, profile_key_handle: input.keyHandle,
        profile_unlock_material: input.unlockMaterial,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { profileId: frame.result.profile_id, profileSelector: frame.result.profile_selector }
  }

  /**
   * Open one Main-only view lease; abort destroys the connection and revokes all its leases.
   * @param input - opaque binding plus optional cancellation.
   * @returns generation-fenced Profile lease.
   */
  async openProfile(input: {
    readonly authorityEnvironmentId: string
    readonly accountBindingHandle: string
    readonly authorityBindingVersion: number
    readonly signal?: AbortSignal
  }): Promise<ProfileOpenResult> {
    const request: ProfileOpenRequest = {
      version: 1,
      type: 'request',
      request_id: requestId(),
      method: 'profile.open',
      params: {
        ...this.auth(), authority_environment_id: input.authorityEnvironmentId as never,
        account_binding_handle: input.accountBindingHandle as never,
        authority_binding_version: input.authorityBindingVersion,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== 'profile.open') throw new HostAuthorityError('unavailable')
    return {
      profileId: frame.result.profile_id as never,
      viewLeaseId: frame.result.view_lease_id as never,
      viewActivationHandle: frame.result.view_activation_handle as never,
      leaseGeneration: frame.result.lease_generation,
      expiresAt: frame.result.expires_at,
      runtimeGeneration: frame.result.runtime_generation,
    }
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
      params: {
        ...this.auth(), import_id: input.importId as never, expected_stage_version: input.expectedStageVersion,
        target_profile_selector: input.targetProfileSelector,
      },
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
      params: {
        ...this.auth(), import_id: input.importId as never, expected_stage_version: input.expectedStageVersion,
        target_profile_selector: input.targetProfileSelector,
      },
    }
    const frame = await this.call(request, input.signal)
    if (frame.type !== 'result' || frame.method !== request.method) throw new HostAuthorityError('unavailable')
    return { stageVersion: frame.result.stage_version }
  }

  /** Close the local connection; Host revokes every lease it minted. */
  close(): void { this.channel.socket.destroy() }

  private auth(): Pick<
    ProfileStatusRequest['params'],
    'client_instance_id' | 'host_instance_id' | 'host_generation' | 'process_nonce' | 'jti' | 'issued_at' | 'expires_at'
  > {
    const issuedAt = this.now()
    return {
      client_instance_id: this.state.clientInstanceId,
      host_instance_id: this.state.hostInstanceId,
      host_generation: this.state.hostGeneration,
      process_nonce: this.state.processNonce,
      jti: randomUUID() as HostControlJti,
      issued_at: issuedAt,
      expires_at: issuedAt + 15_000,
    }
  }

  private async call(
    request: ProfileStatusRequest | ProfileEnsureRequest | ProfileRestoreRequest
      | HostSessionAttachRequest | HostSessionDetachRequest
      | ProfileOpenRequest | ProfileViewActivateRequest | ProfileLeaseCloseRequest
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
