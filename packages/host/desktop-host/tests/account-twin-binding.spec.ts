import { twinBindingFixture } from '../../control-protocol/tests/twin-binding-fixture.ts'
import { generateKeyPairSync, sign } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { encodeHostTwinBindingDirective } from '@deepseek-ai/dsh-host-control-protocol'
import { operateAccountTwinBinding } from '../src/account-twin-binding.ts'
import { TwinBindingReceipts } from '../src/twin-binding-receipts.ts'

const v = twinBindingFixture()
function fixture() {
  const hostKey = generateKeyPairSync('ed25519'), cloud = generateKeyPairSync('ed25519')
  const publicKey = hostKey.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
  const peer = { ...v.directive.peer, publicKey }
  const directive = { ...v.directive, peer }
  directive.signature = sign(null, Buffer.from(encodeHostTwinBindingDirective(directive)), cloud.privateKey).toString('base64url')
  const input = { directive, command: { operation: 'confirm', requestId: v.requestId, offer: structuredClone(v.offer) } }
  const account = { authorityEnvironmentId: directive.authorityEnvironmentId,
    ownerId: 'local-transport-owner', issuer: directive.accountIssuer, subject: directive.accountSubject,
    accountBindingHandle: directive.accountBindingId, authorityBindingVersion: directive.accountBindingVersion }
  const state = { profile: v.ack.hostProfileId, now: 1500, bytes: undefined as Buffer | undefined }
  const bot = { bot_id: v.ack.botId, actor_ref: 'deepseek-bot:' + v.ack.botId, display_name: 'Project operator' }
  const resolveBotIdentity = vi.fn(async () => bot as typeof bot | null)
  let afterWrite: (() => void) | undefined
  const store = new TwinBindingReceipts({ profileId: state.profile, installationId: peer.installationId, publicKey,
    file: { read: () => state.bytes, ensureDurable: () => {}, write: (bytes, guard) => {
      guard(); state.bytes = Buffer.from(bytes); afterWrite?.()
    } } })
  const options = {
    host: { authorizeCollaborationRegistration() {}, authorizeAccountModelText: () => state.profile as never },
    workers: { resolveBotIdentity }, peer,
    trustedKeyrings: [{ version: 1 as const, environmentId: directive.authorityEnvironmentId, issuer: directive.issuer,
      keys: [{ kid: directive.keyId, publicKeyPem: cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        validFrom: 0, validUntil: 100000 }] }],
    store: vi.fn(() => store), now: () => state.now,
    sign: (bytes: Buffer) => sign(null, bytes, hostKey.privateKey).toString('base64url'),
  }
  return { options, account, input, state, resolveBotIdentity, bot, store,
    afterWrite: (next: typeof afterWrite) => { afterWrite = next },
    call: (body: unknown = input, signal = new AbortController().signal) =>
      operateAccountTwinBinding(options, account, body, signal) }
}

it('enforces parsing, current time, cancellation and actual Profile directly at the executor', async () => {
  const f = fixture()
  await expect(f.call({ private_key: 'not a command' })).rejects.toMatchObject({ code: 'invalid_input' })
  const controller = new AbortController(); controller.abort()
  await expect(f.call(f.input, controller.signal)).rejects.toMatchObject({ code: 'stale' })
  f.state.now = NaN
  await expect(f.call()).rejects.toMatchObject({ code: 'stale' })
  f.state.now = -1
  await expect(f.call()).rejects.toMatchObject({ code: 'stale' })
  f.state.now = 1500; f.state.profile = v.requestId
  await expect(f.call()).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(f.options.store).not.toHaveBeenCalled()
  expect(f.state.bytes).toBeUndefined()
})

it('rejects a different actual Bot, an expired asynchronous read and a replaced Account Profile', async () => {
  const wrong = fixture()
  wrong.resolveBotIdentity.mockResolvedValueOnce({ ...wrong.bot, bot_id: 'other', actor_ref: 'deepseek-bot:other' })
  await expect(wrong.call()).rejects.toMatchObject({ code: 'profile_mismatch' })
  const late = fixture()
  late.resolveBotIdentity.mockImplementationOnce(async () => { late.state.now = late.input.directive.expiresAt; return late.bot })
  await expect(late.call()).rejects.toMatchObject({ code: 'stale' })
  const changed = fixture()
  changed.resolveBotIdentity.mockImplementationOnce(async () => { changed.state.profile = v.requestId; return changed.bot })
  await expect(changed.call()).rejects.toMatchObject({ code: 'stale' })
  for (const f of [wrong, late, changed]) expect(f.state.bytes).toBeUndefined()
})

it('keeps a durable candidate but returns no success after the Profile or deadline changes during publication', async () => {
  const changed = fixture()
  changed.afterWrite(() => { changed.state.profile = v.requestId })
  await expect(changed.call()).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(changed.store.read(changed.input.directive)?.requestId).toBe(v.requestId)
  const expired = fixture()
  expired.afterWrite(() => { expired.state.now = expired.input.directive.expiresAt })
  await expect(expired.call()).rejects.toMatchObject({ code: 'stale' })
  expect(expired.store.read(expired.input.directive)?.requestId).toBe(v.requestId)
})

it('rejects invalid pinned keys and a key not yet valid at issuance', async () => {
  const invalid = fixture()
  invalid.options.trustedKeyrings[0]!.keys[0]!.publicKeyPem = 'not a key'
  await expect(invalid.call()).rejects.toMatchObject({ code: 'unauthorized' })
  const future = fixture()
  future.options.trustedKeyrings[0]!.keys[0]!.validFrom = future.input.directive.issuedAt + 1
  await expect(future.call()).rejects.toMatchObject({ code: 'unauthorized' })
  expect(invalid.state.bytes).toBeUndefined()
  expect(future.state.bytes).toBeUndefined()
})

it('keeps the original receipt but refuses confirmation if the actual Bot disappears during publication', async () => {
  const f = fixture()
  f.afterWrite(() => { f.resolveBotIdentity.mockResolvedValueOnce(null) })
  await expect(f.call()).rejects.toMatchObject({ code: 'profile_mismatch' })
  expect(f.resolveBotIdentity).toHaveBeenCalledTimes(2)
  expect(f.store.read(f.input.directive)?.requestId).toBe(v.requestId)
})
