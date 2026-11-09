/** One unsigned native preparation phase in the original Profile worker. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { describeCollaborationSource, parseCollaborationSourceSnapshot } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import { parseHostNativeRoomPreparationTarget,
  parseHostNativeRoomBindingRead, parseHostNativeRoomPreparationWorkerRead,
  parseHostCollaborationSourceSnapshot, matchHostNativeRoomPreparationWorkerRead,
  type HostNativeRoomBindingRead, type HostNativeRoomPreparationTarget,
  type HostNativeRoomPreparationWorkerRead } from '@deepseek-ai/dsh-host-control-protocol'
import { handleDesktopPrivateRequest } from './desktop-private-read.ts'

interface NativePreparationService {
  readBinding?: (input: { botId: string; roomId: string }) => Promise<unknown>
  prepareBinding?: (input: { botId: string; roomId: string; workspaceId: string; memberSetDigest: string }) => Promise<unknown>
}
type Failure = Exclude<HostNativeRoomPreparationWorkerRead, { state: 'observed' }>
function original(service: object): unknown { return Reflect.get(service, symbols.original) ?? service }
function unavailable(): never { throw Error('native_room_preparation_unavailable') }
function participation(read: HostNativeRoomBindingRead, target: HostNativeRoomPreparationTarget): Failure | undefined {
  if (read.state === 'invalid' || read.state === 'unavailable') return unavailable()
  if (!('bot_id' in read)) return { state: read.state }
  if (read.bot_id !== target.bot_id || read.room_id !== target.room_id || read.workspace_id !== target.workspace_id ||
    read.member_set_digest !== target.member_set_digest) return { state: 'membership_changed' }
  return undefined
}
function sameCoordinates(a: { workspace_id: string; session_id: string; source_message_id: string; source_revision: string },
  b: { workspace_id: string; session_id: string; source_message_id: string; source_revision: string }): boolean {
  return a.workspace_id === b.workspace_id && a.session_id === b.session_id &&
    a.source_message_id === b.source_message_id && a.source_revision === b.source_revision
}

/** Inspect or prepare only the selected participant and its original control Source.
 * @param ctx Profile-local traced providers; replacements invalidate the phase.
 * @param target Already parsed parent request for one phase.
 * @param signal Worker deadline or disconnected receiver; no subsequent effect starts after cancellation.
 * @returns Unsigned original observations; only the parent Host may sign them.
 */
export async function readDesktopNativeRoomPreparation(ctx: Context, target: HostNativeRoomPreparationTarget,
  signal: AbortSignal): Promise<HostNativeRoomPreparationWorkerRead> {
  const native = ctx.get('dsBotSlarkNativeRoom') as NativePreparationService | undefined,
    sessions = ctx.get('sessionController'), workspaces = ctx.get('workspaceRegistry')
  if (!native?.readBinding || !sessions?.readCollaborationSourceSnapshot || !workspaces?.installGroupInputFence)
    return { state: 'upgrade_required' }
  const nativeIdentity = original(native), sessionIdentity = original(sessions), workspaceIdentity = original(workspaces)
  const current = () => {
    signal.throwIfAborted()
    if (Date.now() >= target.expires_at) return unavailable()
    const n: unknown = ctx.get('dsBotSlarkNativeRoom')
    const s = ctx.get('sessionController'), w = ctx.get('workspaceRegistry')
    if (!n || typeof n !== 'object' || !s || !w || original(n) !== nativeIdentity || original(s) !== sessionIdentity ||
      original(w) !== workspaceIdentity) return unavailable()
  }
  current()
  const input = { botId: target.bot_id, roomId: target.room_id }
  let binding = parseHostNativeRoomBindingRead(await native.readBinding(input))
  current()
  let failure = participation(binding, target)
  if (failure) return failure
  if (binding.state !== 'bound') {
    if (target.operation !== 'prepare_source' || target.expected_source !== null) return { state: 'recovery_required' }
    if (binding.state !== 'not_prepared') return { state: 'recovery_required' }
    const exactAdopt: unknown = Reflect.get(sessions, 'supportsExactAdopt')
    if (!native.prepareBinding || exactAdopt !== true) return { state: 'upgrade_required' }
    current()
    const prepared = parseHostNativeRoomBindingRead(await native.prepareBinding({ ...input,
      workspaceId: target.workspace_id, memberSetDigest: target.member_set_digest }))
    current()
    failure = participation(prepared, target)
    if (failure) return failure
    if (prepared.state !== 'bound') return { state: 'recovery_required' }
    binding = parseHostNativeRoomBindingRead(await native.readBinding(input))
    current()
    failure = participation(binding, target)
    if (failure) return failure
    if (binding.state !== 'bound') return { state: 'recovery_required' }
    if (!sameCoordinates(binding.source, prepared.source)) return { state: 'source_conflict' }
  }
  const source = binding.source
  const journal = parseCollaborationSourceSnapshot(await sessions.readCollaborationSourceSnapshot(source, signal))
  current()
  if (!sameCoordinates(journal, source) || journal.active_mentions.length !== 0 ||
    journal.original_message !== '[Slark Agent group membership requested]')
    return { state: 'source_conflict' }
  const snapshot = parseHostCollaborationSourceSnapshot({ descriptor: describeCollaborationSource(journal),
    snapshot_json: JSON.stringify(journal) })
  const expected = target.operation === 'prepare_source' ? target.expected_source
    : target.operation === 'attest_source' ? target.source_challenge : target.source
  if (expected && (!sameCoordinates(snapshot.descriptor, expected) ||
    snapshot.descriptor.snapshot_digest !== expected.snapshot_digest)) return { state: 'source_conflict' }
  const observation = { bot_id: binding.bot_id, room_id: binding.room_id, workspace_id: binding.workspace_id,
    member_set_digest: binding.member_set_digest, source: snapshot.descriptor }
  let result: HostNativeRoomPreparationWorkerRead
  if (target.operation === 'attest_activation') {
    const beforeFence = parseHostNativeRoomBindingRead(await native.readBinding(input))
    current()
    failure = participation(beforeFence, target)
    if (failure) return failure
    if (beforeFence.state !== 'bound') return { state: 'recovery_required' }
    if (!sameCoordinates(beforeFence.source, source)) return { state: 'source_conflict' }
    current()
    const fence = await workspaces.installGroupInputFence({ workspaceId: snapshot.descriptor.workspace_id,
      sessionId: snapshot.descriptor.session_id, groupId: target.activation_challenge.group_id,
      groupVersion: target.activation_challenge.group_version })
    current()
    result = { state: 'observed', operation: target.operation, observation, activation_fence: {
      workspace_id: fence.workspaceId, session_id: fence.sessionId, group_id: fence.groupId, group_version: fence.groupVersion } }
  } else result = target.operation === 'prepare_source'
    ? { state: 'observed', operation: target.operation, observation, source_snapshot: snapshot }
    : { state: 'observed', operation: target.operation, observation }
  const final = parseHostNativeRoomBindingRead(await native.readBinding(input))
  current()
  failure = participation(final, target)
  if (failure) return failure
  if (final.state !== 'bound') return { state: 'recovery_required' }
  if (!sameCoordinates(final.source, source)) return { state: 'source_conflict' }
  return matchHostNativeRoomPreparationWorkerRead(parseHostNativeRoomPreparationWorkerRead(result), target)
}

/** Serve one token-only phase with actual-settlement receipts and bounded unsigned output.
 * @param req Private parent request; browser cookies grant no access.
 * @param res Noncacheable response without service error details.
 * @param token Current Profile worker token.
 * @param inspect Captured Profile phase implementation.
 * @returns Completion after the admitted phase actually settles.
 */
export async function handleDesktopNativeRoomPreparationRequest(req: IncomingMessage, res: ServerResponse,
  token: string, inspect: (target: HostNativeRoomPreparationTarget, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  return handleDesktopPrivateRequest(req, res, token, inspect, parseHostNativeRoomPreparationTarget,
    parseHostNativeRoomPreparationWorkerRead,
    (result, target) => matchHostNativeRoomPreparationWorkerRead(result, target) === result,
    49_152, 60_000, true)
}
