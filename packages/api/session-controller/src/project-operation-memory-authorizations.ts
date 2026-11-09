/** Request-local operation-memory permissions; only the private authenticated Host owns token creation. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Opaque operation-memory identity; it is never a path or executable handle. */
export type ProjectOperationMemoryId = Branded<'ProjectOperationMemoryId'>
/** Exact positive decimal revision within int64. */
export type ProjectOperationMemoryVersion = Branded<'ProjectOperationMemoryVersion'>
/** Exact nonnegative decimal journal position within int64. */
export type ProjectOperationMemorySequence = Branded<'ProjectOperationMemorySequence'>
/** Lowercase SHA256 digest of the purpose-specific original bytes. */
export type ProjectOperationMemoryDigest = Branded<'ProjectOperationMemoryDigest'>
declare const tokenBrand: unique symbol
/** Process-local opaque object; a caller cannot construct permission by supplying fields. */
export interface ProjectOperationMemoryAuthorizationToken {
  readonly [tokenBrand]: true
}
/** The five source reads; delivery stage/finalize/receipt belong to Host storage. */
export type ProjectOperationMemoryReadOperation =
  | 'prepare_snapshot'
  | 'history_page'
  | 'delta_page'
  | 'search'
  | 'evidence'
/** Journal coordinates without durable-consumption authority. */
export type ProjectOperationMemoryCheckpoint = Readonly<{
  journalEpoch: ProjectOperationMemoryId
  sequence: ProjectOperationMemorySequence
  scopeDigest: ProjectOperationMemoryDigest
  recipientDigest: ProjectOperationMemoryDigest
}>
/** Semantic source endpoint from the original confirmed direction. */
export type ProjectOperationMemorySource = Readonly<{
  side: 'dsh' | 'slark'
  actorRef: ProjectOperationMemoryId
  hostProfileId: ProjectOperationMemoryId | null
  botRootId: ProjectOperationMemoryId | null
  providerId: ProjectOperationMemoryId
  providerVersion: ProjectOperationMemoryId
}>
/** The approved owner-private recipient; group/versioned audiences remain unsupported. */
export type ProjectOperationMemoryRecipient = Readonly<{
  side: 'dsh' | 'slark'
  botRef: ProjectOperationMemoryId
  audienceKind: 'owner_private'
  audienceRef: ProjectOperationMemoryId
  audienceVersion: '1'
  audienceDigest: ProjectOperationMemoryDigest
}>
/** Complete original directional scope, independent of Host wire DTOs or current execution rights. */
export type ProjectOperationMemoryScope = Readonly<{
  bindingId: ProjectOperationMemoryId
  bindingGeneration: ProjectOperationMemoryVersion
  scopeVersion: ProjectOperationMemoryVersion
  projectId: ProjectOperationMemoryId
  twinAgentId: ProjectOperationMemoryId
  twinAuthorityDigest: ProjectOperationMemoryDigest
  sourceRef: ProjectOperationMemorySource
  recipientRef: ProjectOperationMemoryRecipient
  deviceGrantRefs: readonly Readonly<{
    grantId: ProjectOperationMemoryId
    expectedEpoch: ProjectOperationMemoryVersion
  }>[]
  workspaceRefs: readonly Readonly<{
    workspaceId: ProjectOperationMemoryId
    grantId: ProjectOperationMemoryId
    expectedEpoch: ProjectOperationMemoryVersion
  }>[]
  historyFrom: number
  historyTo: number
  timeZone: string
  materialKinds: readonly ('operation' | 'result' | 'experience' | 'suggestion' | 'tombstone')[]
  retentionConsentRef: Readonly<{
    id: ProjectOperationMemoryId
    generation: ProjectOperationMemoryVersion
    consentDigest: ProjectOperationMemoryDigest
    presentationVersion: 'v1'
  }>
  scopeDigest: ProjectOperationMemoryDigest
}>
/** Exact current installation/process peer captured by the authenticated Host. */
export type ProjectOperationMemoryPeer = Readonly<{
  computerId: ProjectOperationMemoryId
  installationId: ProjectOperationMemoryId
  hostRegistryId: ProjectOperationMemoryId | null
  hostEpoch: ProjectOperationMemoryVersion | null
  publicKey: string
  hostInstanceId: ProjectOperationMemoryId
  processNonce: string
}>
/** Actual Account/Profile/Bot/worker tuple, without credentials or a public revalidation callback. */
export type ProjectOperationMemoryLocalIdentity = Readonly<{
  authorityEnvironmentId: ProjectOperationMemoryId
  accountIssuer: string
  accountSubject: ProjectOperationMemoryId
  accountBindingId: ProjectOperationMemoryId
  accountBindingVersion: number
  hostProfileId: ProjectOperationMemoryId
  botId: ProjectOperationMemoryId
  workerId: ProjectOperationMemoryId
  peer: ProjectOperationMemoryPeer
}>
/** Original confirmation command identity; neither its intent nor its Ack is an export permission. */
export type ProjectOperationMemoryConfirmation = Readonly<{
  requestId: ProjectOperationMemoryId
  offerDigest: ProjectOperationMemoryDigest
  payloadDigest: ProjectOperationMemoryDigest
  anchorId: ProjectOperationMemoryId
  confirmationDigest: ProjectOperationMemoryDigest
}>
/** Actual DSP ownership captured under its writer; unknown dependency closure is not made complete. */
export type ProjectOperationMemoryOwnership = Readonly<{
  hostProfileId: ProjectOperationMemoryId
  botId: ProjectOperationMemoryId
  actorRef: ProjectOperationMemoryId
  sessionIds: readonly SessionId[]
}>
/** Persist-once source metadata captured before the original Host confirmation Ack. */
export type ProjectOperationMemoryActivationAnchor = Readonly<{
  anchorId: ProjectOperationMemoryId
  confirmationDigest: ProjectOperationMemoryDigest
  journalEpoch: ProjectOperationMemoryId
  activationSequence: ProjectOperationMemorySequence
  syncStartSequence: ProjectOperationMemorySequence
  sourceAuthorityVersion: ProjectOperationMemoryVersion
  ownership: ProjectOperationMemoryOwnership
}>
type Prepare = Readonly<{
  requestId: ProjectOperationMemoryId
  expectedScopeVersion: ProjectOperationMemoryVersion
  mode: 'history' | 'delta'
}>
type Resume = Readonly<{
  requestId: ProjectOperationMemoryId
  expectedScopeVersion: ProjectOperationMemoryVersion
  mode: 'resume'
  resumeOperation: 'history_page' | 'delta_page' | 'search'
  journalEpoch: ProjectOperationMemoryId
  snapshotId: ProjectOperationMemoryId | null
  throughSequence: ProjectOperationMemorySequence
  checkpoint: ProjectOperationMemoryCheckpoint
  queryDigest: ProjectOperationMemoryDigest | null
}>
type Page = Readonly<{
  journalEpoch: ProjectOperationMemoryId
  afterCursor: ProjectOperationMemoryId | null
  throughSequence: ProjectOperationMemorySequence
  pageSize: number
  maxBytes: number
}>
/** Strictly parsed semantic commands; no callback, key, mode override, delivery mutation or body export. */
export type ProjectOperationMemoryReadCommands = Readonly<{
  prepare_snapshot: Prepare | Resume
  history_page: Page & Readonly<{ snapshotId: ProjectOperationMemoryId }>
  delta_page: Page
  search: Readonly<{
    query: string
    queryDigest: ProjectOperationMemoryDigest
    limit: number
    maxBytes: number
    cursor: ProjectOperationMemoryId | null
  }>
  evidence: Readonly<{
    sourceEventId: ProjectOperationMemoryId
    sourceRevision: ProjectOperationMemoryVersion
    rightId: ProjectOperationMemoryId | null
    rightGeneration: ProjectOperationMemoryVersion | null
    offset: number
    maxBytes: number
  }>
}>
type Common = Readonly<{
  requestId: ProjectOperationMemoryId
  ownerUserId: ProjectOperationMemoryId
  authorityEnvironmentId: ProjectOperationMemoryId
  projectId: ProjectOperationMemoryId
  scope: ProjectOperationMemoryScope
  scopeDigest: ProjectOperationMemoryDigest
  recipientDigest: ProjectOperationMemoryDigest
  local: ProjectOperationMemoryLocalIdentity
  deadline: number
  signal: AbortSignal
}>
/** Confirmation-only metadata permission; execute must reject it, and it cannot read or export journal rows. */
export type ProjectOperationMemoryAnchorAuthorization = Common &
  Readonly<{
    purpose: 'binding_activation_anchor'
    mode: 'source_export'
    operation: null
    command: null
    readDirectiveDigest: null
    local: ProjectOperationMemoryLocalIdentity &
      Readonly<{ peer: ProjectOperationMemoryPeer & Readonly<{ hostRegistryId: null; hostEpoch: null }> }>
    confirmation: ProjectOperationMemoryConfirmation
  }>
/** Active current source permission. Fresh plans obtain H1 revision/epoch from the actual producer, never the old anchor revision. */
export type ProjectOperationMemorySourceAuthorization = Common &
  Readonly<{
    purpose: 'source_read'
    mode: 'source_export'
    readDirectiveDigest: ProjectOperationMemoryDigest
    authorityDigest: ProjectOperationMemoryDigest
    local: ProjectOperationMemoryLocalIdentity &
      Readonly<{
        peer: ProjectOperationMemoryPeer &
          Readonly<{ hostRegistryId: ProjectOperationMemoryId; hostEpoch: ProjectOperationMemoryVersion }>
      }>
    confirmation: ProjectOperationMemoryConfirmation & Readonly<{ ackDigest: ProjectOperationMemoryDigest }>
    anchor: ProjectOperationMemoryActivationAnchor
    /** Null for a new plan; continuation obtains the original actual version from the producer's persisted plan. */
    expectedSourceAuthorityVersion: ProjectOperationMemoryVersion | null
    /** Null for a new plan; continuation preserves the original producer-owned epoch. */
    expectedJournalEpoch: ProjectOperationMemoryId | null
    /** Only a matching Cloud receipt finalized in the Host source delta ledger can supply this; history never advances it. */
    currentCommittedCheckpoint?: ProjectOperationMemoryCheckpoint
  }> &
  {
    [O in ProjectOperationMemoryReadOperation]: Readonly<{
      operation: O
      command: ProjectOperationMemoryReadCommands[O]
    }>
  }[ProjectOperationMemoryReadOperation]
/** Already-activated retained material only; this mode must never reach the DSP source journal. */
export type ProjectOperationMemoryRetainedAuthorization = Common &
  Readonly<{
    purpose: 'retained_read'
    mode: 'retained_recipient'
    operation: 'search' | 'evidence'
    command: ProjectOperationMemoryReadCommands['search'] | ProjectOperationMemoryReadCommands['evidence']
    readDirectiveDigest: ProjectOperationMemoryDigest
    authorityDigest: ProjectOperationMemoryDigest
    consentVersions: readonly Readonly<{ id: ProjectOperationMemoryId; generation: ProjectOperationMemoryVersion }>[]
    materialVersions: readonly Readonly<{
      rightId: ProjectOperationMemoryId
      generation: ProjectOperationMemoryVersion
      sourceRevision: ProjectOperationMemoryVersion
    }>[]
    originProofDigests: readonly ProjectOperationMemoryDigest[]
  }>
/** Closed purposes: historical anchors, fresh active source reads, and current retained-material reads. */
export type ProjectOperationMemoryAuthorization =
  | ProjectOperationMemoryAnchorAuthorization
  | ProjectOperationMemorySourceAuthorization
  | ProjectOperationMemoryRetainedAuthorization
/** Read-only request owner; no public mint, assertion callback, queue or transferable grant exists. */
export interface ProjectOperationMemoryAuthorizations {
  /** Read while the captured request, local provider/worker and deadline remain live.
   * The owning Host separately rechecks actual Account before publication.
   * @param token - Opaque object supplied by the private authenticated Host call.
   * @returns Deeply immutable exact permission, or null on unknown/replaced/cancelled/expired/settled tokens.
   */
  read(token: ProjectOperationMemoryAuthorizationToken): ProjectOperationMemoryAuthorization | null
}
/** Metadata-only source reference; it asserts no retained Right, fact content or complete dependency set. */
export type ProjectOperationMemoryReferenceEvent = Readonly<{
  originSide: 'dsh'
  originActorRef: ProjectOperationMemoryId
  sourceEventId: ProjectOperationMemoryId
  sourceRevision: ProjectOperationMemoryVersion
  sourceSequence: ProjectOperationMemorySequence
  projectId: ProjectOperationMemoryId
  occurredAt: number
  kind: 'operation' | 'result' | 'experience' | 'suggestion' | 'tombstone'
  payloadDigest: ProjectOperationMemoryDigest
  taskRef: ProjectOperationMemoryId | null
  stepRef: ProjectOperationMemoryId | null
  invocationRef: ProjectOperationMemoryId | null
  evidenceRef: ProjectOperationMemoryId | null
  sourcePolicy: 'live_reference_v1'
  sourceLocator: Readonly<{
    providerId: ProjectOperationMemoryId
    sourceEventId: ProjectOperationMemoryId
    sourceRevision: ProjectOperationMemoryVersion
    sourceDigest: ProjectOperationMemoryDigest
  }>
  materialDependencies: readonly []
  content: null
}>
/** Explicit scan gaps; a filtered empty page may advance without asserting every operation is classified. */
export type ProjectOperationMemoryCoverage = Readonly<{
  state: 'complete' | 'partial' | 'unsupported'
  fromSequence: ProjectOperationMemorySequence
  scannedThroughSequence: ProjectOperationMemorySequence
  throughSequence: ProjectOperationMemorySequence
  gaps: readonly Readonly<{
    fromSequence: ProjectOperationMemorySequence
    toSequence: ProjectOperationMemorySequence
    reason: 'history_not_selected' | 'source_unavailable' | 'provider_unsupported' | 'version_gap'
  }>[]
}>
type Prepared = Readonly<{
  journalEpoch: ProjectOperationMemoryId
  snapshotId: ProjectOperationMemoryId | null
  historyCut: Readonly<{ from: number | null; to: number | null; timeZone: string }>
  syncStartSequence: ProjectOperationMemorySequence
  activationSequence: ProjectOperationMemorySequence
  throughSequence: ProjectOperationMemorySequence
  checkpoint: ProjectOperationMemoryCheckpoint
  coverage: ProjectOperationMemoryCoverage
  resumeCursor: ProjectOperationMemoryId | null
}>
type Paged = Readonly<{
  events: readonly ProjectOperationMemoryReferenceEvent[]
  scannedThroughSequence: ProjectOperationMemorySequence
  throughSequence: ProjectOperationMemorySequence
  checkpoint: ProjectOperationMemoryCheckpoint
  nextCursor: ProjectOperationMemoryId | null
  eof: boolean
  coverage: ProjectOperationMemoryCoverage
}>
type Searched = Readonly<{
  items: readonly Readonly<{
    originSide: 'dsh'
    originActorRef: ProjectOperationMemoryId
    sourceEventId: ProjectOperationMemoryId
    sourceRevision: ProjectOperationMemoryVersion
    kind: ProjectOperationMemoryReferenceEvent['kind']
    snippet: ''
    rightId: null
    rightGeneration: null
  }>[]
  searchSnapshotId: ProjectOperationMemoryId
  resumeRef: Readonly<{
    journalEpoch: ProjectOperationMemoryId
    snapshotId: ProjectOperationMemoryId
    throughSequence: ProjectOperationMemorySequence
    checkpoint: ProjectOperationMemoryCheckpoint
    queryDigest: ProjectOperationMemoryDigest
  }>
  nextCursor: ProjectOperationMemoryId | null
  eof: boolean
  coverage: ProjectOperationMemoryCoverage
  materialVersions: readonly []
}>
/** Reference-only source results: search matches exact event IDs and has empty snippets; evidence honestly reports missing. */
export type ProjectOperationMemorySourceResults = Readonly<{
  prepare_snapshot: Prepared
  history_page: Paged
  delta_page: Paged
  search: Searched
  evidence: Readonly<{ status: 'missing' }>
}>
/** Captured actual producer metadata plus bounded results, signed only by the Host after independent validation and publication fencing. */
export type ProjectOperationMemorySourceReply = Readonly<{
  sourceAuthorityVersion: ProjectOperationMemoryVersion
  journalEpoch: ProjectOperationMemoryId
  snapshotId: ProjectOperationMemoryId | null
  /** Actual persisted plan/cursor before-position for pages; null otherwise. Never inferred from target or coverage. */
  previousCheckpoint: ProjectOperationMemoryCheckpoint | null
  ownership: ProjectOperationMemoryOwnership
}> &
  {
    [O in ProjectOperationMemoryReadOperation]: Readonly<{
      operation: O
      result: ProjectOperationMemorySourceResults[O]
    }>
  }[ProjectOperationMemoryReadOperation]
/** Private controlled producer; only the public reader resolves the request-local object token. */
export interface ProjectOperationMemorySourceProducer {
  /** Execute one source read; read the captured reader before/after every await and before returning.
   * @param token - Current source_read/source_export object token; all other modes and purposes reject.
   * @returns Actual bounded reference metadata from the durable source journal, never a SourceProof or authority grant.
   */
  execute(token: ProjectOperationMemoryAuthorizationToken): Promise<ProjectOperationMemorySourceReply>
  /** Capture once under the original confirmation identity, in the actual DSP writer lifecycle.
   * @param token - Current binding_activation_anchor token, which grants metadata capture only.
   * @returns Persisted original anchor; same-key retries never recapture a later journal head.
   */
  captureAnchor(token: ProjectOperationMemoryAuthorizationToken): Promise<ProjectOperationMemoryActivationAnchor>
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    projectOperationMemoryAuthorizations: ProjectOperationMemoryAuthorizations
  }
}
