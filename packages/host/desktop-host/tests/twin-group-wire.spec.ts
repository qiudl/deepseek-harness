import { ProfileWorkerSupervisor } from '../src/worker-supervisor.ts'
import type { NativeRoomPreparationReceiver } from '../src/types.ts'
import { readFileSync } from 'node:fs'
import { parseHostNativeRoomPreparationTarget, parseHostNativeRoomPreparationProof, parseHostCollaborationSourceSnapshot, encodeHostNativeRoomPreparationProofPayload, type HostNativeRoomPreparationTarget, type HostNativeRoomPreparationWorkerRead } from '@deepseek-ai/dsh-host-control-protocol'
import { verifyNativeRoomPreparationSignatures } from '../src/native-room-preparation-signing.ts'
import { parseHostNativeRoomRetirementTarget, encodeHostNativeRoomRetirementProofPayload, type HostNativeRoomRetirementReply } from '@deepseek-ai/dsh-host-control-protocol'
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { encodeHostBoundBotRoomsProofPayload, encodeHostNativeRoomProjectionProofPayload,
  parseHostBoundBotRoomsPage, parseHostBoundBotRoomsTarget, parseHostNativeRoomProjectionTarget,
  parseHostBoundBotRoomsQuery, parseHostNativeRoomProjectionProof } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBoundBotRoomsRead, HostControlFrame, HostNativeRoomReply } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { HostControlAuthority, UnixHostClient } from '../src/unix-transport.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

async function fixture(supported = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-twin-groups-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const time = { value: 1000 }, clock = { now: () => time.value }
  const registry = new ProfileRegistry({ root, deviceIndexKey: Buffer.alloc(32, 7), clock, ...registryFileFixture() })
  const binding = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'binding:groups', authorityBindingVersion: 1 }
  const account = { ...binding, issuer: 'https://accounts.example.test', subject: randomUUID(),
    keyHandle: 'keychain:groups', unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
  const profile = await registry.registerAccount(account)
  const ownerId = randomUUID()
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 5, ensureProfileWorker: async () => undefined,
    verifyAccountAccessToken: (token) => {
      if (token !== 'valid') throw Error('invalid')
      return { issuer: account.issuer, subject: account.subject }
    } })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const identity = { hostInstanceId: randomUUID(), installationId: randomUUID(), installationPublicKey: publicKey,
    installationPrivateKey: keys.privateKey, processNonce: 'A'.repeat(43), executableSignatureDigest: '1'.repeat(64),
    runtimeGeneration: 5, schemaGeneration: 1 }
  const page = parseHostBoundBotRoomsPage({ state: 'page', bot_id: 'operator', workspace_id: randomUUID(),
    state_revision: 1, membership_snapshot: 'a'.repeat(64), items: [{ room_id: 'room-1', member_set_digest: 'b'.repeat(64) }], next_cursor: null })
  const list = vi.fn(async (_profileId: string, query: Parameters<typeof parseHostBoundBotRoomsQuery>[0],
    _signal: AbortSignal): Promise<HostBoundBotRoomsRead> => {
    // This is the same strict process boundary used by the real web worker.
    expect(parseHostBoundBotRoomsQuery(query)).toEqual({ bot_id: 'operator', limit: 20, cursor: null })
    return page
  })
  const operate = vi.fn(async (_profileId: string, command: { operation: string }, _signal: AbortSignal): Promise<HostNativeRoomReply> =>
    command.operation === 'join' ? { state: 'joined', joined_room_seq: 7 } : { state: 'left', left_room_seq: 9 })
  const retire = vi.fn(async (_profileId: string, _command: unknown, _signal: AbortSignal): Promise<HostNativeRoomRetirementReply> =>
    ({ state: 'left', left_room_seq: 0 }))
  const sourceFixture = JSON.parse(readFileSync(new URL('../../control-protocol/tests/fixtures/native-room-preparation-v1.json', import.meta.url), 'utf8')) as {
    cases: { result: { outcome: { proof: { output: { source_snapshot: unknown } } } } }[] }
  const snapshot = parseHostCollaborationSourceSnapshot(sourceFixture.cases[0]!.result.outcome.proof.output.source_snapshot)
  const phase = vi.fn(async (_profileId: string, target: HostNativeRoomPreparationTarget,
    _signal: AbortSignal): Promise<HostNativeRoomPreparationWorkerRead> => {
    const observation = { bot_id: target.bot_id, room_id: target.room_id, workspace_id: target.workspace_id,
      member_set_digest: target.member_set_digest, source: snapshot.descriptor }
    return target.operation === 'prepare_source' ? { state: 'observed', operation: target.operation, observation, source_snapshot: snapshot }
      : target.operation === 'attest_source' ? { state: 'observed', operation: target.operation, observation }
        : { state: 'observed', operation: target.operation, observation, activation_fence: {
          workspace_id: target.workspace_id, session_id: snapshot.descriptor.session_id,
          group_id: target.activation_challenge.group_id, group_version: target.activation_challenge.group_version } }
  })
  const preparation = parseHostNativeRoomPreparationTarget({ operation: 'prepare_source', challenge_nonce: 'A'.repeat(43),
    expires_at: 2000, binding_id: randomUUID(), binding_generation: '9007199254740993', computer_id: 'original-computer',
    slark_audience: 'https://slark.example.test', expected_profile_id: profile.profileId, bot_id: 'operator', room_id: 'room-1',
    workspace_id: snapshot.descriptor.workspace_id, member_set_digest: 'b'.repeat(64), expected_source: null })
  const receiver = vi.fn((profileId: string): NativeRoomPreparationReceiver => ({
    read: (target, signal) => phase(profileId, target, signal), assertCurrent() {},
  }))
  const authority = new HostControlAuthority({ identity, host, now: clock.now, profilePersistenceGeneration: () => 1,
    ...(supported ? { listBoundBotRooms: list, operateNativeRoom: operate,
      retireNativeRoom: retire, nativeRoomPreparationReceiver: receiver } : {}) })
  const lifetime = new AbortController(), session = authority.openSession(ownerId, lifetime.signal)
  onTestFinished(() => { lifetime.abort(); session.close() })
  const seen: HostControlFrame[] = []
  let alter: ((frame: HostControlFrame) => HostControlFrame) | undefined
  const client = await UnixHostClient.connectAuthenticatedTransport({ trustedInstallationId: identity.installationId,
    trustedInstallationPublicKey: publicKey, trustedExecutableSignatureDigest: identity.executableSignatureDigest, now: clock.now },
  { call: async (frame) => { seen.push(frame); const answer = await session.handleRequest(frame); return alter ? alter(answer) : answer },
    isConnected: () => !lifetime.signal.aborted, close: () => { lifetime.abort(); session.close() } })
  onTestFinished(() => { client.close() })
  const input = { ...binding, issuer: account.issuer, subject: account.subject }
  const challenge = { challenge_nonce: 'A'.repeat(43), expires_at: 2000, binding_id: randomUUID(), binding_generation: '9007199254740993' }
  const target = parseHostBoundBotRoomsTarget({ ...challenge, bot_id: 'operator', limit: 20, cursor: null })
  const projection = parseHostNativeRoomProjectionTarget({ ...challenge, command_request_id: randomUUID(), command: {
    operation: 'join', room_id: 'room-1', group_id: randomUUID(), member_id: randomUUID(), cycle: 1, project_id: 'project', agent_id: 'my-twin', name: 'My twin' } })
  const retirement = parseHostNativeRoomRetirementTarget({ ...challenge,
    join_command_request_id: projection.command_request_id, join_command: projection.command,
    leave_command_request_id: randomUUID(), leave_command: { operation: 'leave', room_id: projection.command.room_id,
      member_id: projection.command.member_id, cycle: projection.command.cycle } })
  return { client, host, ownerId, profile, keys, preparation, snapshot, phase, receiver, page, list, operate, retire, retirement,
    time, input, target, projection, seen,
    grant: () => host.ensureAccountProfile({ ...account, ownerId, accountAccessToken: 'valid' }),
    alter: (next: typeof alter) => { alter = next } }
}

it.skipIf(process.platform === 'win32')('signs the actual authorized Profile page and forwards only the private Bot/page selector', async () => {
  const f = await fixture()
  await expect(f.client.listBoundBotRooms({ ...f.input, target: f.target })).rejects.toMatchObject({ code: 'unauthorized' })
  expect(f.list).not.toHaveBeenCalled()
  await f.grant()
  const result = await f.client.listBoundBotRooms({ ...f.input, target: f.target })
  expect(result.state).toBe('page')
  if (result.state !== 'page') throw Error('expected page')
  expect(result.proof.host_profile_id).toBe(f.profile.profileId)
  expect(result.proof.target).toEqual(f.target)
  expect(verify(null, encodeHostBoundBotRoomsProofPayload(result.proof), f.keys.publicKey, Buffer.from(result.proof.signature, 'base64url'))).toBe(true)
  expect(f.list).toHaveBeenCalledWith(f.profile.profileId, { bot_id: 'operator', limit: 20, cursor: null }, expect.any(AbortSignal))
})

it.skipIf(process.platform === 'win32')('signs the original join and leave cycles without creating a replacement member', async () => {
  const f = await fixture(); await f.grant()
  const joined = await f.client.projectNativeRoom({ ...f.input, target: f.projection })
  expect(joined.reply).toEqual({ state: 'joined', joined_room_seq: 7 })
  expect(joined.host_profile_id).toBe(f.profile.profileId)
  expect(verify(null, encodeHostNativeRoomProjectionProofPayload(joined), f.keys.publicKey, Buffer.from(joined.signature, 'base64url'))).toBe(true)
  const { room_id, member_id, cycle } = f.projection.command
  const target = parseHostNativeRoomProjectionTarget({ ...f.projection, command: { operation: 'leave', room_id, member_id, cycle } })
  expect((await f.client.projectNativeRoom({ ...f.input, target })).reply).toEqual({ state: 'left', left_room_seq: 9 })
  expect(f.operate).toHaveBeenLastCalledWith(f.profile.profileId, target.command, expect.any(AbortSignal))
  expect(f.list).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('preserves changed and unavailable outcomes and refuses unsupported capabilities before dispatch', async () => {
  const f = await fixture(); await f.grant()
  for (const state of ['bot_unavailable', 'snapshot_changed'] as const) {
    f.list.mockResolvedValueOnce({ state })
    expect(await f.client.listBoundBotRooms({ ...f.input, target: f.target })).toEqual({ state })
  }
  for (const state of ['upgrade_required', 'unavailable', 'invalid'] as const) {
    f.list.mockResolvedValueOnce({ state })
    await expect(f.client.listBoundBotRooms({ ...f.input, target: f.target })).rejects.toMatchObject({ code: state === 'upgrade_required' ? state : 'unavailable' })
  }
  const old = await fixture(false); await old.grant(); const before = old.seen.length
  await expect(old.client.listBoundBotRooms({ ...old.input, target: old.target })).rejects.toMatchObject({ code: 'upgrade_required' })
  await expect(old.client.projectNativeRoom({ ...old.input, target: old.projection })).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(old.seen).toHaveLength(before)
  Reflect.set(old.client.inspection, 'capabilities', [...old.client.inspection.capabilities,
    'profile.bound_bot_rooms', 'profile.native_room_projection'])
  await expect(old.client.listBoundBotRooms({ ...old.input, target: old.target })).rejects.toMatchObject({ code: 'upgrade_required' })
  await expect(old.client.projectNativeRoom({ ...old.input, target: old.projection })).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(old.list).not.toHaveBeenCalled(); expect(old.operate).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('enforces nonce expiry before and after IO and current owner revocation', async () => {
  const f = await fixture(); await f.grant()
  for (const expires_at of [1000, 31001]) {
    await expect(f.client.listBoundBotRooms({ ...f.input, target: { ...f.target, expires_at } })).rejects.toMatchObject({ code: 'stale' })
    await expect(f.client.projectNativeRoom({ ...f.input, target: { ...f.projection, expires_at } })).rejects.toMatchObject({ code: 'stale' })
  }
  expect(f.list).not.toHaveBeenCalled(); expect(f.operate).not.toHaveBeenCalled()
  f.list.mockImplementationOnce(async () => { f.time.value = 2000; return f.page })
  await expect(f.client.listBoundBotRooms({ ...f.input, target: f.target })).rejects.toMatchObject({ code: 'stale' })
  f.time.value = 1000
  f.operate.mockImplementationOnce(async () => { f.host.revokeOwner(f.ownerId); return { state: 'joined', joined_room_seq: 7 } })
  await expect(f.client.projectNativeRoom({ ...f.input, target: f.projection })).rejects.toMatchObject({ code: 'unauthorized' })
})

it.skipIf(process.platform === 'win32')('refuses tampered pages, identities, original commands and signatures', async () => {
  const f = await fixture(); await f.grant()
  for (const part of ['signature', 'host_profile_id', 'account_subject', 'process_nonce', 'target', 'page'] as const) {
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.bound_bot_rooms' || frame.result.state !== 'page') return frame
      const proof = frame.result.proof
      const changed = part === 'signature' ? 'A'.repeat(86) : part === 'process_nonce' ? 'B'.repeat(42) + 'A'
        : part === 'target' ? { ...proof.target, binding_generation: '2' }
          : part === 'page' ? { ...proof.page, membership_snapshot: 'c'.repeat(64) } : randomUUID()
      return { ...frame, result: { state: 'page', proof: { ...proof, [part]: changed } } }
    })
    await expect(f.client.listBoundBotRooms({ ...f.input, target: f.target })).rejects.toMatchObject({ code: 'profile_mismatch' })
  }
  for (const part of ['signature', 'account_subject'] as const) {
    f.alter(frame => frame.type === 'result' && frame.method === 'profile.native_room_projection'
      ? { ...frame, result: { proof: parseHostNativeRoomProjectionProof({ ...frame.result.proof,
        [part]: part === 'signature' ? 'A'.repeat(86) : randomUUID() }) } } : frame)
    await expect(f.client.projectNativeRoom({ ...f.input, target: f.projection })).rejects.toMatchObject({ code: 'profile_mismatch' })
  }
  f.alter(frame => frame.type === 'result' && frame.method === 'profile.native_room_projection'
    ? { ...frame, result: { proof: { ...frame.result.proof,
      target: parseHostNativeRoomProjectionTarget({ ...frame.result.proof.target, command_request_id: randomUUID() }) } } } : frame)
  await expect(f.client.projectNativeRoom({ ...f.input, target: f.projection })).rejects.toMatchObject({ code: 'profile_mismatch' })
})

it.skipIf(process.platform === 'win32')('never signs conflicts, unavailable projections or a reply of the wrong operation', async () => {
  const f = await fixture(); await f.grant()
  for (const reply of [{ state: 'conflict' }, { state: 'unavailable' }, { state: 'left', left_room_seq: 9 }] as const) {
    f.operate.mockResolvedValueOnce(reply)
    await expect(f.client.projectNativeRoom({ ...f.input, target: f.projection })).rejects.toMatchObject({ code: reply.state === 'conflict' ? 'conflict' : 'unavailable' })
  }
})

it.skipIf(process.platform === 'win32').each(['page', 'bot_unavailable', 'snapshot_changed', 'projection'] as const)(
  'rejects a valid Host result when its original authenticated connection has closed: %s', async (mode) => {
    const f = await fixture(); await f.grant()
    if (mode === 'snapshot_changed' || mode === 'bot_unavailable') f.list.mockResolvedValueOnce({ state: mode })
    f.alter((frame) => { f.client.close(); return frame })
    const result = mode === 'projection'
      ? f.client.projectNativeRoom({ ...f.input, target: f.projection })
      : f.client.listBoundBotRooms({ ...f.input, target: f.target })
    await expect(result).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.client.isConnected()).toBe(false)
  },
)

it.skipIf(process.platform === 'win32').each(['page', 'projection'] as const)(
  'rejects response-time peer drift and cancellation even with a real signature: %s', async (mode) => {
    for (const change of ['peer', 'cancel'] as const) {
      const f = await fixture(); await f.grant()
      const cancel = new AbortController()
      f.alter((frame) => {
        if (change === 'peer') Reflect.set(f.client.inspection, 'process_nonce', 'C'.repeat(42) + 'A')
        else cancel.abort()
        return frame
      })
      const result = mode === 'page'
        ? f.client.listBoundBotRooms({ ...f.input, target: f.target, signal: cancel.signal })
        : f.client.projectNativeRoom({ ...f.input, target: f.projection, signal: cancel.signal })
      if (change === 'peer') await expect(result).rejects.toMatchObject({ code: 'unavailable' })
      else await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    }
  },
)

it.skipIf(process.platform === 'win32').each(['page', 'projection'] as const)(
  'rejects a response of another method or a reflected request: %s', async (mode) => {
    for (const response of ['method', 'request'] as const) {
      const f = await fixture(); await f.grant()
      f.alter(frame => response === 'request' ? f.seen.at(-1)! : {
        version: 1, type: 'result', request_id: frame.request_id, method: 'profile.bot_roster', result: { page: null },
      })
      const result = mode === 'page'
        ? f.client.listBoundBotRooms({ ...f.input, target: f.target })
        : f.client.projectNativeRoom({ ...f.input, target: f.projection })
      await expect(result).rejects.toMatchObject({ code: 'unavailable' })
    }
  },
)

it.skipIf(process.platform === 'win32')('retirement signs the complete original pair only through the actual current Account Profile', async () => {
  const f = await fixture()
  await expect(f.client.retireNativeRoom({ ...f.input, target: f.retirement })).rejects.toMatchObject({ code: 'unauthorized' })
  expect(f.retire).not.toHaveBeenCalled()
  await f.grant()
  const proof = await f.client.retireNativeRoom({ ...f.input, target: f.retirement })
  expect(proof.target).toEqual(f.retirement)
  expect(proof.reply).toEqual({ state: 'left', left_room_seq: 0 })
  expect(proof.host_profile_id).toBe(f.profile.profileId)
  expect(f.retire).toHaveBeenCalledWith(f.profile.profileId, f.retirement.join_command, expect.any(AbortSignal))
  expect(verify(null, encodeHostNativeRoomRetirementProofPayload(proof), f.keys.publicKey,
    Buffer.from(proof.signature, 'base64url'))).toBe(true)
  expect(f.operate).not.toHaveBeenCalled()
  expect(f.list).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('retirement requires its independent callback and refuses every unsuccessful plugin result', async () => {
  const old = await fixture(false); await old.grant()
  const before = old.seen.length
  await expect(old.client.retireNativeRoom({ ...old.input, target: old.retirement })).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(old.seen).toHaveLength(before)
  Reflect.set(old.client.inspection, 'capabilities', [...old.client.inspection.capabilities, 'profile.native_room_retirement'])
  await expect(old.client.retireNativeRoom({ ...old.input, target: old.retirement })).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(old.retire).not.toHaveBeenCalled()
  const f = await fixture(); await f.grant()
  for (const state of ['upgrade_required', 'conflict', 'unavailable', 'invalid'] as const) {
    f.retire.mockResolvedValueOnce({ state })
    await expect(f.client.retireNativeRoom({ ...f.input, target: f.retirement }))
      .rejects.toMatchObject({ code: state === 'invalid' ? 'unavailable' : state })
  }
})

it.skipIf(process.platform === 'win32')('retirement rechecks expiry and Account after its awaited close', async () => {
  const f = await fixture(); await f.grant()
  for (const expires_at of [1000, 31001])
    await expect(f.client.retireNativeRoom({ ...f.input, target: { ...f.retirement, expires_at } })).rejects.toMatchObject({ code: 'stale' })
  expect(f.retire).not.toHaveBeenCalled()
  f.retire.mockImplementationOnce(async () => { f.time.value = 2000; return { state: 'left', left_room_seq: 0 } })
  await expect(f.client.retireNativeRoom({ ...f.input, target: f.retirement })).rejects.toMatchObject({ code: 'stale' })
  f.time.value = 1000
  f.retire.mockImplementationOnce(async () => { f.host.revokeOwner(f.ownerId); return { state: 'left', left_room_seq: 0 } })
  await expect(f.client.retireNativeRoom({ ...f.input, target: f.retirement })).rejects.toMatchObject({ code: 'unauthorized' })
})

it.skipIf(process.platform === 'win32')('retirement refuses proof tampering and changed original command requests', async () => {
  const f = await fixture(); await f.grant()
  for (const part of ['signature', 'account_subject', 'process_nonce', 'target'] as const) {
    f.alter(frame => frame.type === 'result' && frame.method === 'profile.native_room_retirement'
      ? { ...frame, result: { proof: { ...frame.result.proof,
        [part]: part === 'signature' ? 'A'.repeat(86) : part === 'process_nonce' ? 'C'.repeat(42) + 'A' :
          part === 'target' ? { ...frame.result.proof.target, leave_command_request_id: randomUUID() } : randomUUID() } } } : frame)
    await expect(f.client.retireNativeRoom({ ...f.input, target: f.retirement })).rejects.toMatchObject({ code: 'profile_mismatch' })
  }
})

it.skipIf(process.platform === 'win32').each(['closed', 'peer', 'cancel', 'method', 'request'] as const)(
  'retirement rejects response-time transport changes: %s', async (mode) => {
    const f = await fixture(); await f.grant()
    const cancel = new AbortController()
    f.alter((frame) => {
      if (mode === 'closed') f.client.close()
      if (mode === 'peer') Reflect.set(f.client.inspection, 'process_nonce', 'C'.repeat(42) + 'A')
      if (mode === 'cancel') cancel.abort()
      if (mode === 'request') return f.seen.at(-1)!
      if (mode === 'method') return { version: 1, type: 'result', request_id: frame.request_id,
        method: 'profile.bot_roster', result: { page: null } }
      return frame
    })
    await expect(f.client.retireNativeRoom({ ...f.input, target: f.retirement, signal: cancel.signal }))
      .rejects.toMatchObject(mode === 'cancel' ? { name: 'AbortError' } : { code: 'unavailable' })
  },
)


it.skipIf(process.platform === 'win32')('runs each new phase with original artifacts and verifies both domains through the SDK', async () => {
  const f = await fixture()
  await expect(f.client.prepareNativeRoomPhase({ ...f.input, target: f.preparation })).rejects.toMatchObject({ code: 'unauthorized' })
  expect(f.phase).not.toHaveBeenCalled()
  await f.grant()
  const { operation: _operation, expected_source: _expected, ...base } = f.preparation.operation === 'prepare_source' ? f.preparation : (() => { throw Error('wrong phase') })()
  const descriptor = f.snapshot.descriptor
  const challenge = { request_id: randomUUID(), challenge_nonce: 'A'.repeat(43), expires_at: 2000,
    audience: base.slark_audience, environment_id: f.input.authorityEnvironmentId,
    account_issuer: f.input.issuer, account_subject: f.input.subject,
    workspace_id: descriptor.workspace_id, session_id: descriptor.session_id }
  const targets = [f.preparation,
    parseHostNativeRoomPreparationTarget({ ...base, operation: 'attest_source', source_challenge: {
      ...challenge, source_message_id: descriptor.source_message_id, source_revision: '1', snapshot_digest: descriptor.snapshot_digest, host_epoch: '1' } }),
    parseHostNativeRoomPreparationTarget({ ...base, operation: 'attest_activation', source: descriptor,
      activation_challenge: { ...challenge, group_id: randomUUID(), group_version: 1 } })]
  for (const target of targets) {
    const result = await f.client.prepareNativeRoomPhase({ ...f.input, target })
    expect(result.state).toBe('prepared')
    if (result.state !== 'prepared') throw Error('missing proof')
    expect(result.proof.host_profile_id).toBe(f.profile.profileId)
    expect(result.proof.target).toEqual(target)
    expect(verifyNativeRoomPreparationSignatures(result.proof, (payload, signature) =>
      verify(null, payload, f.keys.publicKey, Buffer.from(signature, 'base64url')))).toBe(true)
    expect(f.phase).toHaveBeenLastCalledWith(f.profile.profileId, target, expect.any(AbortSignal))
  }
  expect(f.list).not.toHaveBeenCalled(); expect(f.operate).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('preserves phase inability, rejects old capabilities before dispatch and prevents signing after revocation', async () => {
  const f = await fixture(); await f.grant()
  for (const state of ['membership_changed', 'not_prepared', 'recovery_required', 'bot_unavailable', 'room_unavailable', 'source_conflict', 'too_large'] as const) {
    f.phase.mockResolvedValueOnce({ state })
    expect(await f.client.prepareNativeRoomPhase({ ...f.input, target: f.preparation })).toEqual({ state })
  }
  f.phase.mockResolvedValueOnce({ state: 'upgrade_required' })
  await expect(f.client.prepareNativeRoomPhase({ ...f.input, target: f.preparation })).rejects.toMatchObject({ code: 'upgrade_required' })
  const old = await fixture(false); await old.grant(); const before = old.seen.length
  await expect(old.client.prepareNativeRoomPhase({ ...old.input, target: old.preparation })).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(old.seen).toHaveLength(before)
  Reflect.set(old.client.inspection, 'capabilities', [...old.client.inspection.capabilities, 'profile.native_room_preparation'])
  await expect(old.client.prepareNativeRoomPhase({ ...old.input, target: old.preparation })).rejects.toMatchObject({ code: 'upgrade_required' })
  expect(old.phase).not.toHaveBeenCalled()
  f.phase.mockImplementationOnce(async () => { f.host.revokeOwner(f.ownerId); return { state: 'not_prepared' } })
  await expect(f.client.prepareNativeRoomPhase({ ...f.input, target: f.preparation })).rejects.toMatchObject({ code: 'unauthorized' })
})

it.skipIf(process.platform === 'win32')('rejects target substitution and old-artifact forgery despite a valid outer signature', async () => {
  const f = await fixture(); await f.grant()
  for (const kind of ['target', 'old-signature'] as const) {
    f.alter((frame) => {
      if (frame.type !== 'result' || frame.method !== 'profile.native_room_preparation' || frame.result.outcome.state !== 'prepared') return frame
      const proof = frame.result.outcome.proof
      if (proof.output.operation !== 'prepare_source') throw Error('wrong artifact')
      const unsigned = parseHostNativeRoomPreparationProof(kind === 'target'
        ? { ...proof, target: { ...proof.target, binding_generation: '2' } }
        : { ...proof, output: { ...proof.output, native_room_assertion: { ...proof.output.native_room_assertion, signature: 'A'.repeat(86) } } })
      const changed = parseHostNativeRoomPreparationProof({ ...unsigned,
        signature: sign(null, encodeHostNativeRoomPreparationProofPayload(unsigned), f.keys.privateKey).toString('base64url') })
      return { ...frame, result: { outcome: { state: 'prepared', proof: changed } } }
    })
    await expect(f.client.prepareNativeRoomPhase({ ...f.input, target: f.preparation })).rejects.toMatchObject({ code: 'profile_mismatch' })
  }
})

it.skipIf(process.platform === 'win32')('refuses Account revocation between the helper post-I/O check and parent signing', async () => {
  const f = await fixture(); await f.grant()
  const authorize = f.host.authorizeAccountModelText.bind(f.host), phase = f.phase.getMockImplementation()
  if (!phase) throw Error('missing original phase fixture')
  let phaseComplete = false, queued = false, revoked = false
  f.phase.mockImplementationOnce(async (...args) => {
    const read = await phase(...args)
    phaseComplete = true
    return read
  })
  vi.spyOn(f.host, 'authorizeAccountModelText').mockImplementation((account) => {
    const profile = authorize(account)
    if (phaseComplete && !queued) {
      queued = true
      queueMicrotask(() => { f.host.revokeOwner(f.ownerId); revoked = true })
    }
    return profile
  })
  await expect(f.client.prepareNativeRoomPhase({ ...f.input, target: f.preparation })).rejects.toMatchObject({ code: 'unauthorized' })
  expect(revoked).toBe(true)
})

it.skipIf(process.platform === 'win32')('refuses the original worker after disposal in the final Account-to-parent continuation', async () => {
  const f = await fixture(); await f.grant()
  const phase = f.phase.getMockImplementation()
  if (!phase) throw Error('missing original phase fixture')
  const done = Promise.withResolvers<undefined>(), abort = vi.fn(() => { done.resolve(undefined) })
  let readComplete = false, queued = false, disposing: Promise<void> | undefined
  const workers = new ProfileWorkerSupervisor(async () => ({ closeNotifications() {}, abort, done: done.promise,
    prepareNativeRoomPhase: async (target, signal) => {
      const value = await phase(f.profile.profileId, target, signal)
      readComplete = true
      return value
    } }))
  onTestFinished(() => workers.disposeAll())
  await workers.start({ profileId: f.profile.profileId, profileRoot: '/synthetic-fixture', credentialHandle: 'fixture', pluginRoots: [] })
  f.receiver.mockImplementation(profileId => workers.nativeRoomPreparationReceiver(profileId))
  const authorize = f.host.authorizeAccountModelText.bind(f.host)
  vi.spyOn(f.host, 'authorizeAccountModelText').mockImplementation((account) => {
    const profile = authorize(account)
    if (readComplete && !queued) {
      queued = true
      queueMicrotask(() => { disposing = workers.disposeAll() })
    }
    return profile
  })
  try {
    await expect(f.client.prepareNativeRoomPhase({ ...f.input, target: f.preparation })).rejects.toMatchObject({ code: 'stale' })
    expect(abort).toHaveBeenCalledOnce()
  } finally { await disposing }
})
