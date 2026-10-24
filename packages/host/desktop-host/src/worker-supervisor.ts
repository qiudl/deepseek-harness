import { matchHostRootPlanningAttemptTarget } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRootPlanningAttemptDescriptor, HostControlRequestId } from '@deepseek-ai/dsh-host-control-protocol'
import { parseHostRootJournalCommand, matchHostRootJournalMetadata, type HostRootJournalCommand, type HostRootJournalMetadata } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostRootSubmissionTarget, HostRootSubmissionDescriptor } from '@deepseek-ai/dsh-host-control-protocol'
import type { ProfileWorkerFactory, ProfileWorkerHandle, ProfileWorkerSpec } from './types.ts'
import type { HostCollaborationReferenceGrant, HostControlSha256, HostCollaborationReferenceSelection,
  HostCollaborationReferenceContentTarget, HostCollaborationReferenceContentChunk } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostWorkspaceModelSelectionTarget, HostWorkspaceModelSelection, HostCollaborationSourceTarget, HostCollaborationSourceDescriptor, HostCollaborationSourceSnapshot, HostRemoteSessionCommand, HostRemoteSessionJson } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostCollaborationArchiveStateTarget, HostCollaborationArchiveStateValue,
  HostGroupInputFenceChallenge, HostGroupInputFenceValue,
  HostCollaborationArchiveIntentTarget, HostCollaborationArchiveIntentValue,
  HostCollaborationArchiveTransitionTarget, HostCollaborationArchiveTransitionResult } from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'
import type { HostControlAuthorityOptions } from './unix-transport.ts'
import type { CollaborationDeliveryReceiver } from './collaboration-delivery-uploads.ts'
import type { HostBotGroupCommand, HostBotGroupResponse } from '@deepseek-ai/dsh-host-control-protocol'
import { matchesHostNativeRoomReply } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostNativeRoomCommand, HostNativeRoomReply } from '@deepseek-ai/dsh-host-control-protocol'

interface StartProfileWorkerInput {
  readonly profileId: string
  readonly profileRoot: string
  readonly credentialHandle: string
  readonly pluginRoots: readonly string[]
}

/** Owns one isolated child per unlocked Profile and awaits quiescence on disposal. */
export class ProfileWorkerSupervisor {
  private closed = false
  private readonly workers = new Map<string, ProfileWorkerHandle>()
  private readonly pending = new Map<string, Promise<void>>()
  constructor(private readonly factory: ProfileWorkerFactory,
    private readonly assertMayStart?: (profileId: string) => void) {}

  /**
   * Read a Bot identity from the same live exclusive-writer Profile worker.
   * @param profileId - Selected Account Profile.
   * @param botId - Exact local Bot ID.
   * @param signal - Caller cancellation.
   * @returns Public Bot identity or absence.
   */
  async resolveBotIdentity(profileId: string, botId: string, signal: AbortSignal): Promise<import('@deepseek-ai/dsh-host-control-protocol').HostBotIdentity | null> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.resolveBotIdentity) throw new HostAuthorityError('unavailable')
    const result = await worker.resolveBotIdentity(botId, signal)
    signal.throwIfAborted()
    this.assertCurrentWorker(profileId, worker)
    if (result !== null && result.bot_id !== botId) throw new HostAuthorityError('profile_mismatch')
    return result
  }

  /**
   * Read one ordered page from the current Account Profile worker.
   * @param profileId - Selected Account Profile.
   * @param afterBotId - Exclusive Bot ID cursor.
   * @param limit - Maximum identities in this page.
   * @param signal - Caller cancellation.
   * @returns Public Bot roster page or absence.
   */
  async listBotRoster(profileId: string, afterBotId: string, limit: number, signal: AbortSignal):
  Promise<import('@deepseek-ai/dsh-host-control-protocol').HostBotRosterPage | null> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.listBotRoster) throw new HostAuthorityError('unavailable')
    const page = await worker.listBotRoster(afterBotId, limit, signal)
    signal.throwIfAborted()
    this.assertCurrentWorker(profileId, worker)
    if (page && (page.bots.length > limit || page.bots.some(bot => bot.bot_id <= afterBotId)))
      throw new HostAuthorityError('profile_mismatch')
    return page
  }

  /**
   * Prepare one native room only in the current Account Profile worker.
   * @param profileId - Selected Account Profile.
   * @param roomId - Existing native room Session ID.
   * @param signal - Caller cancellation.
   * @returns Separate bridge Source or absence.
   */
  async prepareNativeRoom(profileId: string, roomId: string, signal: AbortSignal):
  Promise<import('@deepseek-ai/dsh-host-control-protocol').HostNativeRoomSource | null> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.prepareNativeRoom) throw new HostAuthorityError('unavailable')
    const binding = await worker.prepareNativeRoom(roomId, signal)
    signal.throwIfAborted()
    this.assertCurrentWorker(profileId, worker)
    if (binding !== null && binding.room_id !== roomId) throw new HostAuthorityError('profile_mismatch')
    return binding
  }

  /**
   * Use only the current Account Profile worker for an authorized Bot group command.
   * @param profileId - Selected Account Profile.
   * @param command - Host-validated group operation.
   * @param signal - Caller cancellation.
   * @returns Worker reply for the exact operation.
   */
  async operateBotGroup(profileId: string, command: HostBotGroupCommand,
    signal: AbortSignal): Promise<HostBotGroupResponse> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.operateBotGroup) throw new HostAuthorityError('unavailable')
    const result = await worker.operateBotGroup(command, signal)
    signal.throwIfAborted()
    this.assertCurrentWorker(profileId, worker)
    return result
  }

  /** Admit a native room operation only from the selected live Profile writer.
   * @param profileId Selected Account Profile.
   * @param command Bounded member or message command.
   * @param signal Caller cancellation signal.
   * @returns Reply from the same live worker generation.
   */
  async operateNativeRoom(profileId: string, command: HostNativeRoomCommand,
    signal: AbortSignal): Promise<HostNativeRoomReply> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.operateNativeRoom) throw new HostAuthorityError('unavailable')
    const reply = await worker.operateNativeRoom(command, signal)
    signal.throwIfAborted()
    this.assertCurrentWorker(profileId, worker)
    if (!matchesHostNativeRoomReply(reply, command)) throw new HostAuthorityError('profile_mismatch')
    return reply
  }

  private assertCurrentWorker(profileId: string, worker: ProfileWorkerHandle): void {
    if (this.closed || this.workers.get(profileId) !== worker) throw new HostAuthorityError('stale')
  }

  /**
   * Start one Profile worker with an explicit, non-ambient environment.
   * @param input - Profile root, credential handle, and allowed plugin roots.
   */
  async start(input: StartProfileWorkerInput): Promise<void> {
    if (this.closed) throw new HostAuthorityError('unavailable')
    return this.serial(input.profileId, () => this.startOwned(input))
  }

  private async startOwned(input: StartProfileWorkerInput): Promise<void> {
    if (this.workers.has(input.profileId)) throw new HostAuthorityError('conflict')
    this.assertMayStart?.(input.profileId)
    const spec: ProfileWorkerSpec = {
      ...input,
      pluginRoots: [...input.pluginRoots],
      env: {},
    }
    this.workers.set(input.profileId, await this.factory(spec))
    try { this.assertMayStart?.(input.profileId) }
    catch (error) {
      await this.disposeOwned(input.profileId)
      throw error
    }
  }

  /**
   * Start a Profile worker once and reuse the running generation on retries.
   * @param input - Profile-owned runtime inputs.
   */
  async ensure(input: StartProfileWorkerInput): Promise<void> {
    if (this.closed) throw new HostAuthorityError('unavailable')
    await this.serial(input.profileId, async () => {
      this.assertMayStart?.(input.profileId)
      if (!this.workers.has(input.profileId)) await this.startOwned(input)
      this.assertMayStart?.(input.profileId)
    })
  }

  /**
   * Take ownership of a ready import worker while the durable fence is held.
   * @param profileId - Target Profile ID.
   * @param worker - Attested candidate worker.
   * @param assertFenced - Throws if the caller no longer owns the import fence.
   */
  async adoptImportCandidate(profileId: string, worker: ProfileWorkerHandle,
    assertFenced: () => void): Promise<void> {
    const state = { adopted: false }
    try {
      await this.serial(profileId, () => {
        if (this.closed) throw new HostAuthorityError('unavailable')
        assertFenced()
        if (this.workers.has(profileId)) throw new HostAuthorityError('conflict')
        if (!worker.viewOrigin || !worker.generation || !worker.bootstrapCookie) {
          throw new HostAuthorityError('unavailable')
        }
        this.workers.set(profileId, worker)
        state.adopted = true
        return Promise.resolve()
      })
    } finally {
      if (!state.adopted) {
        worker.closeNotifications()
        worker.abort()
        await worker.done.catch(() => undefined)
      }
    }
  }

  /**
   * Return the Host-verified listener for one running Profile worker.
   * @param profileId - Profile whose leased view is activated.
   * @returns exact loopback origin and worker generation.
   */
  async activate(profileId: string): Promise<{
    readonly origin: string
    readonly generation: number
    readonly bootstrapCookie: { readonly name: string; readonly value: string }
  }> {
    await Promise.resolve()
    this.assertMayStart?.(profileId)
    const worker = this.workers.get(profileId)
    if (!worker || worker.viewOrigin === undefined || worker.generation === undefined || worker.bootstrapCookie === undefined) {
      throw new HostAuthorityError('unavailable')
    }
    return { origin: worker.viewOrigin, generation: worker.generation, bootstrapCookie: worker.bootstrapCookie }
  }

  /**
   * Invoke the running Profile worker without exposing its private token.
   * @param profileId - Profile containing the selected model and credentials.
   * @param text - one bounded user input.
   * @param signal - request cancellation from the owning Host connection.
   * @returns the selected model identity and bounded answer text.
   */
  async generateText(profileId: string, text: string, signal: AbortSignal): Promise<{
    readonly provider: string
    readonly model: string
    readonly text: string
  }> {
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.generateText) throw new HostAuthorityError('unavailable')
    return worker.generateText(text, signal)
  }

  /**
   * Read the selected worker and discard replies after its generation is disposed.
   * @param profileId - Account Profile resolved by the Host authority.
   * @param target - Registry workspace and Session identities.
   * @param signal - Owning connection cancellation.
   * @returns The effective choice; unavailable, replaced, mismatched or cancelled reads reject.
   */
  async inspectWorkspaceModelSelection(
    profileId: string,
    target: HostWorkspaceModelSelectionTarget,
    signal: AbortSignal,
  ): Promise<HostWorkspaceModelSelection> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.inspectWorkspaceModelSelection) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.inspectWorkspaceModelSelection(target, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    if (result.workspace_id !== target.workspace_id || result.session_id !== target.session_id) {
      throw new HostAuthorityError('profile_mismatch')
    }
    return result
  }

  /** Read only the currently selected Account Profile's durable archive phase.
   * @param profileId - Authorized Profile identity.
   * @param target - Exact token and Account tuple.
   * @param signal - Owning connection cancellation.
   * @returns Current worker's persisted phase.
   */
  async inspectCollaborationArchiveState(
    profileId: string, target: HostCollaborationArchiveStateTarget, signal: AbortSignal,
  ): Promise<HostCollaborationArchiveStateValue> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.inspectCollaborationArchiveState) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.inspectCollaborationArchiveState(target, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    return result
  }

  /** Discard a recovered token from a worker replaced while the lookup was pending.
   * @param profileId - Authorized Account Profile.
   * @param target - Session and Account tuple without a caller token.
   * @param signal - Owning control connection cancellation.
   * @returns Current worker's original token or explicit absence.
   */
  async inspectCollaborationArchiveIntent(
    profileId: string, target: HostCollaborationArchiveIntentTarget, signal: AbortSignal,
  ): Promise<HostCollaborationArchiveIntentValue> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.inspectCollaborationArchiveIntent) throw new HostAuthorityError('unavailable')
    const result = await worker.inspectCollaborationArchiveIntent(target, signal)
    signal.throwIfAborted()
    this.assertCurrentWorker(profileId, worker)
    return result
  }

  /** An uncertain reply after a worker replacement must be reconciled by the durable token.
   * @param profileId - Authorized Profile identity.
   * @param target - Exact token and phase action.
   * @param signal - Owning connection cancellation.
   * @returns Current worker's persisted phase.
   */
  async transitionCollaborationArchive(
    profileId: string, target: HostCollaborationArchiveTransitionTarget, signal: AbortSignal,
  ): Promise<HostCollaborationArchiveTransitionResult> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.transitionCollaborationArchive) throw new HostAuthorityError('unavailable')
    const result = await worker.transitionCollaborationArchive(target, signal)
    signal.throwIfAborted()
    this.assertCurrentWorker(profileId, worker)
    return result
  }

  /** Discard acknowledgements from a replaced Profile worker after the durable write.
   * @param profileId - Account-authorized Profile identity.
   * @param challenge - Exact preparing group and original Session.
   * @param signal - Owning connection cancellation.
   * @returns Current worker's persisted fence.
   */
  async installGroupInputFence(
    profileId: string, challenge: HostGroupInputFenceChallenge, signal: AbortSignal,
  ): Promise<HostGroupInputFenceValue> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.installGroupInputFence) throw new HostAuthorityError('unavailable')
    const result = await worker.installGroupInputFence(challenge, signal)
    signal.throwIfAborted()
    this.assertCurrentWorker(profileId, worker)
    return result
  }

  /**
   * Read the selected worker and discard replies after its generation is disposed.
   * @param profileId - Account Profile resolved by the Host authority.
   * @param input - Original journal read or receipt acknowledgement.
   * @param signal - Owning connection cancellation.
   * @returns Matched committed metadata from the unchanged worker generation.
   */
  async rootJournal(profileId: string, input: HostRootJournalCommand, signal: AbortSignal): Promise<HostRootJournalMetadata> {
    signal.throwIfAborted()
    const command = parseHostRootJournalCommand(input), worker = this.workers.get(profileId)
    if (this.closed || !worker?.rootJournal) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.rootJournal(command, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    return matchHostRootJournalMetadata(result, command)
  }
  /** Read live attempt metadata and discard replies from replaced or stopped workers.
   * @param profileId - Account-authorized Profile.
   * @param target - Original root lookup.
   * @param attemptId - Persisted fresh attempt identity.
   * @param binding - Current parent-derived connection ownership digest.
   * @param signal - Request cancellation.
   * @returns Matched metadata from the unchanged worker generation.
   */
  async inspectRootPlanningAttempt(profileId: string, target: HostRootSubmissionTarget, attemptId: HostControlRequestId,
    binding: string, signal: AbortSignal): Promise<HostRootPlanningAttemptDescriptor> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.inspectRootPlanningAttempt) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.inspectRootPlanningAttempt(target, attemptId, binding, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    return matchHostRootPlanningAttemptTarget(result, target, attemptId)
  }
  /** Read committed root binding metadata.
   * @param profileId - Current Account Profile.
   * @param target - Original journal lookup.
   * @param signal - Owning connection cancellation.
   * @returns Metadata from the unchanged worker generation.
   */
  async inspectCollaborationRoot(
    profileId: string,
    target: HostRootSubmissionTarget,
    signal: AbortSignal,
  ): Promise<HostRootSubmissionDescriptor> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.inspectCollaborationRoot) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.inspectCollaborationRoot(target, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    const source = result.source_descriptor
    if (result.namespace_id !== target.namespace_id || result.command_id !== target.command_id
      || source.workspace_id !== target.workspace_id || source.session_id !== target.session_id
      || source.source_message_id !== target.source_message_id || source.source_revision !== target.source_revision) {
      throw new HostAuthorityError('profile_mismatch')
    }
    return result
  }
  /**
   * Read the selected worker and discard replies after its generation is disposed.
   * @param profileId - Account Profile resolved by the Host authority.
   * @param target - Original Source coordinates.
   * @param signal - Owning connection cancellation.
   * @returns The committed digest; unavailable, replaced, mismatched or cancelled reads reject.
   */
  async inspectCollaborationSource(
    profileId: string,
    target: HostCollaborationSourceTarget,
    signal: AbortSignal,
  ): Promise<HostCollaborationSourceDescriptor> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.inspectCollaborationSource) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.inspectCollaborationSource(target, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    if (result.workspace_id !== target.workspace_id || result.session_id !== target.session_id
      || result.source_message_id !== target.source_message_id || result.source_revision !== target.source_revision) {
      throw new HostAuthorityError('profile_mismatch')
    }
    return result
  }
  /**
   * Read a separately committed reference selection from the original current worker.
   * @param profileId - Account Profile resolved by the parent authority.
   * @param target - Exact original Source coordinates.
   * @param requestDigest - Complete reference reservation digest; it creates no record.
   * @param signal - Current connection cancellation.
   * @returns original grant; missing, replaced, cancelled or mismatched workers refuse.
   */
  async readCollaborationReferenceGrant(profileId: string, target: HostCollaborationSourceTarget,
    requestDigest: HostControlSha256, signal: AbortSignal): Promise<HostCollaborationReferenceGrant> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.readCollaborationReferenceGrant) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.readCollaborationReferenceGrant(target, requestDigest, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    if (result.workspace_id !== target.workspace_id || result.session_id !== target.session_id
      || result.source_message_id !== target.source_message_id || result.source_revision !== target.source_revision
      || result.reference_request_digest !== requestDigest) throw new HostAuthorityError('profile_mismatch')
    return result
  }

  /**
   * Capture authorized locator metadata with the current worker's separate Reference token.
   * @param profileId - Current Account Profile resolved by Host authority.
   * @param selection - Coordinator-authorized selection; no content or computed fields.
   * @param signal - Current connection cancellation.
   * @returns untrusted computed metadata; disposed, replaced and cancelled workers refuse.
   */
  async captureCollaborationReferenceSelection(profileId: string, selection: HostCollaborationReferenceSelection,
    signal: AbortSignal): Promise<HostRemoteSessionJson> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.captureCollaborationReferenceSelection) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.captureCollaborationReferenceSelection(selection, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    return result
  }

  /**
   * Read a selected-byte chunk through the current worker's independent Reference capability.
   * @param profileId - Current Account Profile resolved by Host authority.
   * @param target - Original Source, full committed reservation digest and byte offset.
   * @param signal - Current connection cancellation.
   * @returns Chunk only while the original worker is current; disposed, replaced and cancelled reads refuse.
   */
  async readCollaborationReferenceContent(profileId: string, target: HostCollaborationReferenceContentTarget,
    signal: AbortSignal): Promise<HostCollaborationReferenceContentChunk> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.readCollaborationReferenceContent) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.readCollaborationReferenceContent(target, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    return result
  }

  /**
   * Execute private analysis using the original Account worker generation.
   * @param profileId - Host-authorized Profile identity.
   * @param command - Bounded prepare/dispatch JSON with Host-derived binding digest.
   * @param signal - Current connection cancellation.
   * @returns original worker result; replacement, closure or cancellation rejects.
   */
  async collaborationAnalysis(profileId: string, command: HostRemoteSessionJson, signal: AbortSignal): Promise<HostRemoteSessionJson> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.collaborationAnalysis) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.collaborationAnalysis(command, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    return result
  }
  /**
   * Capture a current worker for the complete original reply upload and durable commit.
   * @param profileId - Verified Account's running Profile, selected by parent authority.
   * @returns Private receiver that refuses closure, worker replacement or cancellation before and after writes.
   */
  collaborationDeliveryReceiver(profileId: string): CollaborationDeliveryReceiver {
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.receiveCollaborationDelivery) throw new HostAuthorityError('unavailable')
    const receive = worker.receiveCollaborationDelivery.bind(worker)
    const assertCurrent = () => {
      if (this.closed || this.workers.get(profileId) !== worker) throw new HostAuthorityError('stale')
    }
    return { assertCurrent, receive: async (capsule, signal) => {
      signal.throwIfAborted(); assertCurrent()
      const result = await receive(capsule, signal)
      signal.throwIfAborted(); assertCurrent()
      return result
    } }
  }

  /**
   * Read original Source JSON from the current Account Profile worker.
   * @param profileId - Host-authorized Profile.
   * @param target - Exact journal identity.
   * @param signal - Owning connection cancellation.
   * @returns Original capsule; replaced, detached, unsupported or cancelled workers reject.
   */
  async readCollaborationSourceSnapshot(
    profileId: string,
    target: HostCollaborationSourceTarget,
    signal: AbortSignal,
  ): Promise<HostCollaborationSourceSnapshot> {
    signal.throwIfAborted()
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.readCollaborationSourceSnapshot) throw new HostAuthorityError('unavailable')
    const current = () => !this.closed && this.workers.get(profileId) === worker
    const result = await worker.readCollaborationSourceSnapshot(target, signal)
    signal.throwIfAborted()
    if (!current()) throw new HostAuthorityError('stale')
    const d = result.descriptor
    if (
      d.workspace_id !== target.workspace_id ||
      d.session_id !== target.session_id ||
      d.source_message_id !== target.source_message_id ||
      d.source_revision !== target.source_revision
    )
      throw new HostAuthorityError('profile_mismatch')
    return result
  }

  /**
   * Execute one closed Session command in the running Profile worker.
   * @param profileId - Active Profile identity.
   * @param command - Validated Session operation.
   * @param signal - Cancellation for this request.
   * @returns The worker's JSON response.
   */
  async remoteSession(
    profileId: string,
    command: HostRemoteSessionCommand,
    signal: AbortSignal,
  ): Promise<HostRemoteSessionJson> {
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.remoteSession) throw new HostAuthorityError('unavailable')
    return worker.remoteSession(command, signal)
  }

  /**
   * Invoke a read in the active Profile worker without releasing its private token.
   * @param profileId - Lease-selected Profile identity.
   * @param endpoint - Exact read endpoint.
   * @param payload - Bounded RPC arguments.
   * @param signal - Request cancellation.
   * @returns The worker's read projection.
   */
  async remoteUiRead(profileId: string, endpoint: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.remoteUiRead) throw new HostAuthorityError('unavailable')
    return worker.remoteUiRead(endpoint, payload, signal)
  }

  /**
   * Open the active Profile worker's native Session event stream.
   * @param profileId - Lease-selected Profile identity.
   * @param endpoint - Exact Session-follow endpoint.
   * @param payload - Validated Session-follow arguments.
   * @param signal - Host-owned cancellation signal.
   * @param itemChunks - Explicitly negotiated source-side history fragmentation.
   * @returns Native Session events until cancellation or end.
   */
  remoteUiStream(profileId: string, endpoint: string, payload: unknown, signal: AbortSignal, itemChunks = false): AsyncIterable<unknown> {
    const worker = this.workers.get(profileId)
    if (this.closed || !worker?.remoteUiStream) throw new HostAuthorityError('unavailable')
    return worker.remoteUiStream(endpoint, payload, signal, itemChunks)
  }

  /**
   * Stop notifications before cancellation, then await the child's exit.
   * @param profileId - worker owner to dispose.
   */
  async dispose(profileId: string): Promise<void> {
    return this.serial(profileId, () => this.disposeOwned(profileId))
  }

  private async disposeOwned(profileId: string): Promise<void> {
    const worker = this.workers.get(profileId)
    if (!worker) return
    this.workers.delete(profileId)
    worker.closeNotifications()
    worker.abort()
    await worker.done
  }

  private serial(profileId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(profileId) ?? Promise.resolve()
    const current = previous.then(operation)
    // A failed start has no retained worker. Later cleanup must still run and await the same owner.
    const settled = current.catch(() => {}).finally(() => {
      if (this.pending.get(profileId) === settled) this.pending.delete(profileId)
    })
    this.pending.set(profileId, settled)
    return current
  }

  /** Permanently refuse new starts and dispose all children, including pending starts, despite individual failures. */
  async disposeAll(): Promise<void> {
    this.closed = true
    const ids = new Set([...this.workers.keys(), ...this.pending.keys()])
    const results = await Promise.allSettled([...ids].map(profileId => this.dispose(profileId)))
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}

/**
 * Bind original Profile readers for the platform startup compositions.
 * @param workers - Supervisor owning the current unlocked Profile generations.
 * @returns Source and reference readers with their supervisor receiver retained; cloud transfer requires separate authority.
 */
export function collaborationWorkerReaders(workers: ProfileWorkerSupervisor): Pick<HostControlAuthorityOptions,
  'inspectWorkspaceModelSelection' | 'inspectCollaborationArchiveState' | 'installGroupInputFence' | 'inspectCollaborationArchiveIntent' | 'transitionCollaborationArchive' | 'inspectCollaborationSource' | 'readCollaborationSourceSnapshot' | 'readCollaborationReferenceGrant'
  | 'captureCollaborationReferenceSelection' | 'readCollaborationReferenceContent'> {
  return {
    inspectWorkspaceModelSelection: workers.inspectWorkspaceModelSelection.bind(workers),
    inspectCollaborationArchiveState: workers.inspectCollaborationArchiveState.bind(workers),
    installGroupInputFence: workers.installGroupInputFence.bind(workers),
    inspectCollaborationArchiveIntent: workers.inspectCollaborationArchiveIntent.bind(workers),
    transitionCollaborationArchive: workers.transitionCollaborationArchive.bind(workers),
    inspectCollaborationSource: workers.inspectCollaborationSource.bind(workers),
    readCollaborationSourceSnapshot: workers.readCollaborationSourceSnapshot.bind(workers),
    readCollaborationReferenceGrant: workers.readCollaborationReferenceGrant.bind(workers),
    captureCollaborationReferenceSelection: workers.captureCollaborationReferenceSelection.bind(workers),
    readCollaborationReferenceContent: workers.readCollaborationReferenceContent.bind(workers),
  }
}
