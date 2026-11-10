/** Native plugin fixtures inside the real Loader, journal, workspace and HTTP composition. */
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { collaborationJournalDigest, describeCollaborationSource } from '@deepseek-ai/dsh-api-session-controller'
import { parseHostNativeRoomPreparationTarget, type HostNativeRoomPreparationTarget } from '@deepseek-ai/dsh-host-control-protocol'
import { expect, vi } from 'vitest'

/** Exercise the private route mounted by WebApp with actual persisted Source and fence owners.
 * @param ctx Loader-mounted services, with a keyless model adapter.
 * @param origin Owned loopback server.
 * @param workspaceId Original test workspace.
 * @param sessionId Original test Session.
 */
export async function nativePreparationLoaderChecks(ctx: Context, origin: string, workspaceId: WorkspaceId,
  sessionId: SessionId): Promise<void> {
  const captured = await ctx.sessionController.captureCollaborationSource({ workspace_id: workspaceId,
    session_id: sessionId, source_message_id: 'native-control-message', source_revision: '1',
    original_message: '[Slark Agent group membership requested]', active_mentions: [] }, new AbortController().signal)
  const descriptor = describeCollaborationSource(captured.snapshot)
  const coordinates = { workspace_id: workspaceId, session_id: sessionId,
    source_message_id: descriptor.source_message_id, source_revision: '1' }
  const base = { challenge_nonce: Buffer.alloc(32, 7).toString('base64url'), expires_at: Date.now() + 60_000,
    binding_id: '10000000-0000-4000-8000-000000000001', binding_generation: '1', computer_id: 'fixture-computer',
    slark_audience: 'https://slark.example', expected_profile_id: '20000000-0000-4000-8000-000000000002',
    bot_id: 'selected-bot', room_id: 'native-room', workspace_id: workspaceId, member_set_digest: 'a'.repeat(64) }
  const prepare = parseHostNativeRoomPreparationTarget({ ...base, operation: 'prepare_source', expected_source: null })
  const common = { request_id: '30000000-0000-4000-8000-000000000003', challenge_nonce: Buffer.alloc(32, 8).toString('base64url'),
    expires_at: base.expires_at, audience: base.slark_audience, environment_id: '50000000-0000-4000-8000-000000000005', account_issuer: 'https://account.example',
    account_subject: '60000000-0000-4000-8000-000000000006', workspace_id: workspaceId, session_id: sessionId }
  const source = parseHostNativeRoomPreparationTarget({ ...base, operation: 'attest_source', source_challenge: {
    ...common, source_message_id: descriptor.source_message_id, source_revision: '1', snapshot_digest: descriptor.snapshot_digest, host_epoch: '1' } })
  const activation = parseHostNativeRoomPreparationTarget({ ...base, operation: 'attest_activation', source: descriptor,
    activation_challenge: { ...common, group_id: '40000000-0000-4000-8000-000000000004', group_version: 1 } })
  let state: 'bound' | 'not_prepared' | 'recovery_required' = 'bound', memberDigest = base.member_set_digest
  let beforeRead: (() => void) | undefined
  const receivers: object[] = []
  const native = new class extends Service {
    constructor(owner: Context) { super(owner, 'dsBotSlarkNativeRoom') }
    async readBinding(): Promise<unknown> {
      receivers.push(this)
      beforeRead?.()
      return { state, bot_id: base.bot_id, room_id: base.room_id, workspace_id: workspaceId,
        member_set_digest: memberDigest, ...(state === 'bound' ? { source: coordinates } : {}) }
    }
    prepare = vi.fn(() => { throw Error('unscoped preparation must never run') })
    prepareBinding = vi.fn(async (_input: object) => {
      state = 'bound'
      return native.readBinding()
    })
  }(ctx)
  const post = (target: HostNativeRoomPreparationTarget, headers: Record<string, string> = {}) =>
    fetch(`${origin}/internal/desktop-native-room-preparation`, { method: 'POST',
      headers: { authorization: `Bearer ${'A'.repeat(43)}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(target) })
  try {
    expect((await post(prepare, { authorization: '', cookie: 'dsh_session=fixture' })).status).toBe(403)
    expect((await post(prepare, { 'x-dsh-native-drain': 'bad' })).status).toBe(400)
    for (const target of [prepare, source, activation, activation]) {
      const nonce = Buffer.alloc(32, 9).toString('base64url')
      const response = await post(target, { 'x-dsh-native-drain': nonce })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-dsh-native-settled')).toBe(nonce)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toMatchObject({ state: 'observed', operation: target.operation,
        observation: { bot_id: base.bot_id, room_id: base.room_id, source: descriptor } })
    }
    expect(ctx.workspaceRegistry.groupInputFences).toEqual([{ workspaceId, sessionId,
      groupId: '40000000-0000-4000-8000-000000000004', groupVersion: 1 }])
    expect(ctx.workspaceRegistry.isGroupInputBlocked(sessionId)).toBe(true)
    expect(native.prepareBinding).not.toHaveBeenCalled()
    const first: unknown = ctx.get('dsBotSlarkNativeRoom'), second: unknown = ctx.get('dsBotSlarkNativeRoom')
    expect(first).not.toBe(second)
    if (!first || typeof first !== 'object') throw Error('missing native provider')
    expect(Reflect.get(first, symbols.original)).toBe(native)
    expect(receivers.every(value => value !== native && Reflect.get(value, symbols.original) === native)).toBe(true)
    state = 'not_prepared'
    const known = parseHostNativeRoomPreparationTarget({ ...base, operation: 'prepare_source', expected_source: descriptor })
    expect(await (await post(known)).json()).toEqual({ state: 'recovery_required' })
    expect(native.prepareBinding).not.toHaveBeenCalled()
    state = 'recovery_required'
    expect(await (await post(prepare)).json()).toEqual({ state: 'recovery_required' })
    state = 'not_prepared'
    expect((await post(prepare)).status).toBe(200)
    expect(native.prepareBinding).toHaveBeenCalledExactlyOnceWith({ botId: base.bot_id, roomId: base.room_id,
      workspaceId, memberSetDigest: base.member_set_digest })
    memberDigest = 'b'.repeat(64)
    expect(await (await post(source)).json()).toEqual({ state: 'membership_changed' })
    memberDigest = base.member_set_digest
    const journal = vi.spyOn(ctx.sessionController, 'readCollaborationSourceSnapshot')
    for (const changed of [
      { ...captured.snapshot, model_snapshot: { ...captured.snapshot.model_snapshot, api_key: 'forbidden-fixture-field' } },
      { ...captured.snapshot, original_message: 'changed' },
      { ...captured.snapshot, host_journal_commit: { ...captured.snapshot.host_journal_commit, content_digest: 'f'.repeat(64) } },
    ]) {
      journal.mockResolvedValueOnce(changed)
      expect((await post(source)).status).toBe(422)
    }
    journal.mockRestore()
    let readCount = 0
    beforeRead = () => { if (++readCount === 2) memberDigest = 'b'.repeat(64) }
    const install = vi.spyOn(ctx.workspaceRegistry, 'installGroupInputFence')
    expect(await (await post(activation)).json()).toEqual({ state: 'membership_changed' })
    expect(install).not.toHaveBeenCalled()
    install.mockRestore(); beforeRead = undefined; memberDigest = base.member_set_digest
    const sourceProvider = ctx.sessionController, workspaceProvider = ctx.workspaceRegistry
    for (const name of ['dsBotSlarkNativeRoom', 'sessionController', 'workspaceRegistry'] as const) {
      const actual: object = name === 'dsBotSlarkNativeRoom' ? native : name === 'sessionController' ? sourceProvider : workspaceProvider
      const original: unknown = Reflect.get(actual, symbols.original)
      const raw = original && typeof original === 'object' ? original : actual
      const owner: unknown = name === 'dsBotSlarkNativeRoom' ? ctx : Reflect.get(raw, 'ctx')
      if (!(owner instanceof Context)) throw Error('missing service owner')
      beforeRead = () => { owner.set(name, Object.create(raw)) }
      try { expect((await post(source)).status).toBe(422) }
      finally { owner.set(name, raw); beforeRead = undefined }
    }
    const bound = { state: 'bound', bot_id: base.bot_id, room_id: base.room_id, workspace_id: workspaceId,
      member_set_digest: base.member_set_digest, source: coordinates }
    const { source: _source, ...facts } = bound
    const pending = { ...facts, state: 'not_prepared' }
    const reads = vi.spyOn(native, 'readBinding')
    for (const state of ['invalid', 'unavailable']) {
      reads.mockResolvedValueOnce({ state })
      expect((await post(prepare)).status).toBe(422)
    }
    for (const state of ['bot_unavailable', 'room_unavailable', 'source_conflict']) {
      reads.mockResolvedValueOnce({ state })
      expect(await (await post(prepare)).json()).toEqual({ state })
    }
    ctx.set('dsBotSlarkNativeRoom', undefined)
    expect(await (await post(prepare)).json()).toEqual({ state: 'upgrade_required' })
    ctx.set('dsBotSlarkNativeRoom', { readBinding: native.readBinding.bind(native) })
    expect((await post(source)).status).toBe(200)
    ctx.set('dsBotSlarkNativeRoom', native)
    reads.mockResolvedValueOnce(pending)
    const guarded = native.prepareBinding
    Reflect.set(native, 'prepareBinding', undefined)
    try { expect(await (await post(prepare)).json()).toEqual({ state: 'upgrade_required' }) }
    finally { Reflect.set(native, 'prepareBinding', guarded) }
    const rawController: unknown = Reflect.get(ctx.sessionController, symbols.original)
    if (!rawController || typeof rawController !== 'object') throw Error('missing original controller')
    Object.defineProperty(rawController, 'supportsExactAdopt', { configurable: true, value: false })
    reads.mockResolvedValueOnce(pending)
    try { expect(await (await post(prepare)).json()).toEqual({ state: 'upgrade_required' }) }
    finally { Reflect.deleteProperty(rawController, 'supportsExactAdopt') }
    for (const prepared of [{ state: 'membership_changed' }, pending]) {
      reads.mockResolvedValueOnce(pending)
      guarded.mockResolvedValueOnce(prepared)
      expect(await (await post(prepare)).json()).toEqual({ state: prepared.state === 'membership_changed'
        ? 'membership_changed' : 'recovery_required' })
    }
    for (const after of [{ state: 'room_unavailable' }, pending,
      { ...bound, source: { ...coordinates, source_message_id: 'changed-source' } }]) {
      reads.mockResolvedValueOnce(pending).mockResolvedValueOnce(after)
      guarded.mockResolvedValueOnce(bound)
      expect(await (await post(prepare)).json()).toEqual({ state: after.state === 'room_unavailable' ? 'room_unavailable'
        : after.state === 'not_prepared' ? 'recovery_required' : 'source_conflict' })
    }
    const { host_journal_commit, ...body } = captured.snapshot
    const originalJournal = vi.spyOn(ctx.sessionController, 'readCollaborationSourceSnapshot')
    for (const changedBody of [{ ...body, session_id: 'changed-session' },
      { ...body, source_revision: '2' }, { ...body, original_message: 'different control text' }]) {
      originalJournal.mockResolvedValueOnce({ ...changedBody, host_journal_commit: { ...host_journal_commit,
        content_digest: collaborationJournalDigest(changedBody) } })
      expect(await (await post(source)).json()).toEqual({ state: 'source_conflict' })
    }
    originalJournal.mockRestore()
    if (source.operation !== 'attest_source') throw Error('wrong source phase')
    for (const change of [{ source_message_id: 'changed-source' }, { snapshot_digest: 'f'.repeat(64) }]) {
      const changed = parseHostNativeRoomPreparationTarget({ ...source,
        source_challenge: { ...source.source_challenge, ...change } })
      expect(await (await post(changed)).json()).toEqual({ state: 'source_conflict' })
    }
    for (const target of [source, activation]) {
      for (const after of [{ state: 'membership_changed' }, pending,
        { ...bound, source: { ...coordinates, source_message_id: 'changed-source' } }]) {
        reads.mockResolvedValueOnce(bound).mockResolvedValueOnce(after)
        expect(await (await post(target)).json()).toEqual({ state: after.state === 'membership_changed' ? 'membership_changed'
          : after.state === 'not_prepared' ? 'recovery_required' : 'source_conflict' })
      }
    }
    expect((await post({ ...prepare, expires_at: Date.now() - 1 })).status).toBe(422)
    reads.mockRestore()
    expect(native.prepare).not.toHaveBeenCalled()
  } finally { ctx.set('dsBotSlarkNativeRoom', undefined) }
}
