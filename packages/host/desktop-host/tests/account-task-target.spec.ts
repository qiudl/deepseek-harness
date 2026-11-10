/** Actual Account leases and real signatures; worker transport is controlled, with no Agent/body execution. */
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { expect, it, onTestFinished } from 'vitest'
import {
  parseHostTaskTargetPrepareDirective, parseHostTaskTargetDescriptor, parseHostTaskReadyAdmissionDirective,
  parseHostTaskTargetConsumeChallenge, parseHostTaskTargetConsumeReceipt, parseHostTaskTargetObserveDirective,
  parseHostTaskTargetObservation, parseHostTaskCoordinationScope, hostTaskCoordinationScopeDigest,
  hostTaskCoordinationFloorDigest, hostTaskTargetOriginalStepHash, hostTaskTargetDescriptorDigest,
  hostTaskReadyAdmissionDirectiveDigest, hostTaskTargetConsumeChallengeDigest, hostTaskStepPayloadDigest,
  hostTaskTargetObserveDirectiveDigest, hostTaskTargetInventoryDigest,
  encodeHostTaskTargetPrepareDirective, encodeHostTaskTargetDescriptor, encodeHostTaskReadyAdmissionDirective,
  encodeHostTaskTargetConsumeChallenge, encodeHostTaskTargetConsumeReceipt, encodeHostTaskTargetObserveDirective,
  encodeHostTaskTargetObservation, captureHostTaskTargetCall, parseHostRemoteSessionJson,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { HostTaskTargetCall } from '@deepseek-ai/dsh-host-control-protocol'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'
import { operateAccountTaskTarget, type AccountTaskTargetOptions } from '../src/account-task-target.ts'

const vectorJson: unknown = JSON.parse(readFileSync(
  new URL('../../control-protocol/tests/fixtures/task-target-v1.json', import.meta.url), 'utf8'))
const vectors = vectorJson as Record<string, unknown>
const unsigned = 'A'.repeat(86)
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'req0006-main-task-target-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const time = { value: 1800000000100 }, clock = { now: () => time.value }
  const registry = new ProfileRegistry({ root: directory, clock, deviceIndexKey: Buffer.alloc(32, 7), ...registryFileFixture() })
  const identity = { authorityEnvironmentId: randomUUID(), accountBindingHandle: 'real-current-binding', authorityBindingVersion: 1,
    issuer: 'https://account.test', subject: randomUUID(), keyHandle: 'key', unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
  const host = new DesktopHost({ registry, clock, runtimeGeneration: 1, ensureProfileWorker: async () => {},
    verifyAccountAccessToken: () => ({ issuer: identity.issuer, subject: identity.subject }) })
  const account = { ...identity, ownerId: randomUUID(), accountAccessToken: 'controlled-verified-token' }
  const profile = await host.ensureAccountProfile(account)
  const cloud = generateKeyPairSync('ed25519'), installation = generateKeyPairSync('ed25519'), workerId = randomUUID()
  const base = parseHostTaskTargetPrepareDirective(vectors.prepare)
  const scope = parseHostTaskCoordinationScope({ ...base.scope, authorityEnvironmentId: account.authorityEnvironmentId,
    accountIssuer: account.issuer, accountSubject: account.subject, hostProfileId: profile.profileId })
  const peer = { ...base.peer, publicKey: installation.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url') }
  const localPeer: AccountTaskTargetOptions['peer'] = {
    installationId: brandString<AccountTaskTargetOptions['peer']['installationId']>(peer.installationId), publicKey: peer.publicKey,
    hostInstanceId: brandString<AccountTaskTargetOptions['peer']['hostInstanceId']>(peer.hostInstanceId),
    processNonce: peer.processNonce }
  const body = JSON.stringify({ schemaVersion: 1, text: '原计划下一步', permissions: { forceReadOnly: true,
    routeReadOnly: true, filesystem: 'read-only', networkAccess: false, skills: null, toolAllowlist: null } })
  const originalStep = { ...base.originalStep, stepPayloadDigest: hostTaskStepPayloadDigest(body) }
  const common = { scope, scopeDigest: hostTaskCoordinationScopeDigest(scope), floorDigest: hostTaskCoordinationFloorDigest(scope),
    peer, issuer: 'https://cloud.test', keyId: 'dsh-assertion-controlled', accountBindingId: account.accountBindingHandle,
    accountBindingVersion: account.authorityBindingVersion }
  const cloudSign = (bytes: string) => sign(null, Buffer.from(bytes), cloud.privateKey).toString('base64url')
  const hostSign = (bytes: string) => sign(null, Buffer.from(bytes), installation.privateKey).toString('base64url')
  const p = parseHostTaskTargetPrepareDirective({ ...base, ...common, originalStep, signature: unsigned })
  const prepare = parseHostTaskTargetPrepareDirective({ ...p, signature: cloudSign(encodeHostTaskTargetPrepareDirective(p)) })
  const d = { ...parseHostTaskTargetDescriptor(vectors.descriptor), scope, peer, issuer: account.issuer,
    target: { ...parseHostTaskTargetDescriptor(vectors.descriptor).target, hostProfileId: profile.profileId, workerId },
    originalStepHash: hostTaskTargetOriginalStepHash(originalStep), signature: unsigned }
  const descriptor = parseHostTaskTargetDescriptor({ ...d, descriptorDigest: hostTaskTargetDescriptorDigest(d) })
  const r = parseHostTaskReadyAdmissionDirective({ ...parseHostTaskReadyAdmissionDirective(vectors.ready), ...common, originalStep,
    targetCoordinatorRef: { side: 'dsh', host_profile_id: profile.profileId, bot_root_id: scope.botId },
    target: descriptor.target, descriptorDigest: descriptor.descriptorDigest, stepPayloadDigest: originalStep.stepPayloadDigest,
    signature: unsigned })
  const ready = parseHostTaskReadyAdmissionDirective({ ...r, signature: cloudSign(encodeHostTaskReadyAdmissionDirective(r)) })
  const challenge = parseHostTaskTargetConsumeChallenge({ ...parseHostTaskTargetConsumeChallenge(vectors.consumeChallenge), scope,
    peer, issuer: account.issuer, target: descriptor.target, descriptorDigest: descriptor.descriptorDigest,
    readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(ready), signature: unsigned })
  const signedChallenge = parseHostTaskTargetConsumeChallenge({ ...challenge, signature:
    hostSign(encodeHostTaskTargetConsumeChallenge(challenge)) })
  const rc = parseHostTaskTargetConsumeReceipt({ ...parseHostTaskTargetConsumeReceipt(vectors.consumeReceipt), scope, peer,
    issuer: common.issuer, keyId: common.keyId, target: descriptor.target, descriptorDigest: descriptor.descriptorDigest,
    readyDirectiveDigest: hostTaskReadyAdmissionDirectiveDigest(ready),
    challengeDigest: hostTaskTargetConsumeChallengeDigest(signedChallenge),
    stepPayloadDigest: originalStep.stepPayloadDigest,
    signature: unsigned })
  const receipt = parseHostTaskTargetConsumeReceipt({ ...rc, signature: cloudSign(encodeHostTaskTargetConsumeReceipt(rc)) })
  const o = parseHostTaskTargetObserveDirective({ ...parseHostTaskTargetObserveDirective(vectors.observeRequest),
    ...common, signature: unsigned })
  const observe = parseHostTaskTargetObserveDirective({ ...o, signature: cloudSign(encodeHostTaskTargetObserveDirective(o)) })
  const observation = parseHostTaskTargetObservation({ ...parseHostTaskTargetObservation(vectors.observation), issuer: account.issuer,
    peer, workerId, directiveDigest: hostTaskTargetObserveDirectiveDigest(observe), scopeDigest: common.scopeDigest,
    floorDigest: common.floorDigest, items: [], totalCount: 0, nextCursor: null, eof: true, coverage: 'unknown',
    quiescence: 'unknown', inventoryDigest: hostTaskTargetInventoryDigest([]), signature: unsigned })
  const calls = {
    prepare: captureHostTaskTargetCall({ operation: 'prepare', directive: prepare }),
    ready: captureHostTaskTargetCall({ operation: 'ready_prepare', directive: ready }),
    start: captureHostTaskTargetCall({ operation: 'ready_start', receipt, stepBody: body }),
    observe: captureHostTaskTargetCall({ operation: 'observe', directive: observe }),
  }
  const actions: string[] = [], claimed: HostTaskTargetCall[] = []
  let replaced = false, signatures = 0
  let original: unknown = { kind: 'task_target_original', proposal: ready, challenge: signedChallenge }
  const recorded = { ok: true, peer, record: { status: 'recorded', commandId: receipt.target.commandId,
    admissionId: receipt.newSourceGrant.admissionId, consumeIntentId: receipt.consumeIntentId, journalEpoch: receipt.target.journalEpoch,
    workerId, state: 'start_intent', messageId: null, turn: null, step: null, recordDigest: 'a'.repeat(64) } }
  let intercept: ((command: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) | undefined
  const options: { -readonly [K in keyof AccountTaskTargetOptions]: AccountTaskTargetOptions[K] } = { host, peer: localPeer, now: clock.now,
    environments: [{ audience: 'urn:slark:task-coordination:v1', environmentKey: scope.environmentKey, keyring: {
      version: 1, environmentId: account.authorityEnvironmentId, issuer: common.issuer, keys: [{ kid: common.keyId,
        publicKeyPem: cloud.publicKey.export({ type: 'spki', format: 'pem' }).toString(), validFrom: time.value - 1000, validUntil: time.value + 60000 }] } }],
    sign(bytes) { signatures++; return sign(null, bytes, installation.privateKey).toString('base64url') },
    claimNonce(input) { claimed.push(input) },
    receiver: () => ({ workerId, assertCurrent() { if (replaced) throw Error('actual worker replaced') },
      async execute(raw, signal) {
        signal.throwIfAborted()
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('missing private command')
        const command: Record<string, unknown> = Object.fromEntries(Object.entries(raw))
        if (typeof command.action !== 'string') throw Error('missing private action')
        actions.push(command.action)
        expect(command.actualWorkerId).toBe(workerId)
        expect(command.binding_key).toBe('actual-private-binding')
        expect(command.actualAccount).toMatchObject({ accountBindingId: account.accountBindingHandle, hostProfileId: profile.profileId })
        if (intercept) return parseHostRemoteSessionJson(await intercept(command, signal))
        const input = captureHostTaskTargetCall(command.request)
        if (command.action === 'task_target_run' || command.action === 'task_target_wait_claim') return parseHostRemoteSessionJson({ kind: 'task_target', record: recorded })
        if (command.action === 'task_target_commit') {
          const signed = command.signed
          if (!signed || typeof signed !== 'object' || Array.isArray(signed) || !('kind' in signed) || !('value' in signed)) throw Error('missing signed value')
          return parseHostRemoteSessionJson({ kind: 'task_target', record: { ok: true, peer, record: signed.kind === 'descriptor'
            ? { status: 'prepared', descriptor: signed.value } : { status: 'consume_intent', challenge: signed.value } } })
        }
        if (input.operation === 'ready_start') return parseHostRemoteSessionJson(original)
        const record = input.operation === 'prepare' ? { status: 'prepared', descriptor }
          : input.operation === 'ready_prepare' ? { status: 'consume_intent', challenge } : { status: 'observed', observation }
        return parseHostRemoteSessionJson({ kind: 'task_target', record: { ok: true, peer, record } })
      } }),
  }
  const run = (value: unknown, signal = new AbortController().signal) => operateAccountTaskTarget(options, account, value, 'actual-private-binding', signal)
  return { account, host, profile, time, options, calls, run, actions, claimed, descriptor, challenge, ready, receipt, observation,
    peer, installation, cloudSign, hostSign, recorded, signatures: () => signatures,
    replace() { replaced = true }, original(value: unknown) { original = value },
    intercept(value: typeof intercept) { intercept = value } }
}

it('signs only the original prepared descriptor and persists the exact signed result on the captured receiver', async () => {
  const f = await fixture(), result = await f.run(f.calls.prepare)
  expect(f.actions).toEqual(['task_target', 'task_target_commit'])
  expect(f.claimed).toHaveLength(1)
  if (!result.ok || result.record.status !== 'prepared') throw Error('missing prepared descriptor')
  expect(result.record.descriptor.preparedAt).toBe(f.descriptor.preparedAt)
  expect(verify(null, Buffer.from(encodeHostTaskTargetDescriptor(result.record.descriptor)), f.installation.publicKey,
    Buffer.from(result.record.descriptor.signature, 'base64url'))).toBe(true)
})

it('commits the same durable consume challenge and signs an independent current observation without a fake commit', async () => {
  const f = await fixture(), result = await f.run(f.calls.ready)
  expect(f.actions).toEqual(['task_target', 'task_target_commit'])
  expect(result).toMatchObject({ ok: true, record: { status: 'consume_intent', challenge: { consumeIntentId: f.challenge.consumeIntentId } } })
  f.actions.length = 0
  const observed = await f.run(f.calls.observe)
  expect(f.actions).toEqual(['task_target'])
  if (!observed.ok || observed.record.status !== 'observed') throw Error('missing current observation')
  expect(observed.record.observation.coverage).toBe('unknown')
  expect(verify(null, Buffer.from(encodeHostTaskTargetObservation(observed.record.observation)), f.installation.publicKey,
    Buffer.from(observed.record.observation.signature, 'base64url'))).toBe(true)
})

it('reads the original signed pair before ready_start and returns only exact durable metadata', async () => {
  const f = await fixture()
  expect(await f.run(f.calls.start)).toEqual(f.recorded)
  expect(f.actions).toEqual(['task_target', 'task_target_run', 'task_target_wait_claim'])
  expect(f.signatures()).toBe(0)
})

it('rejects wrong Source signatures, current Account, local peer, expiry and caller flags before contacting the worker', async () => {
  const f = await fixture()
  if (f.calls.prepare.operation !== 'prepare') throw Error('fixture operation')
  await expect(f.run({ ...f.calls.prepare, directive: { ...f.calls.prepare.directive, signature: unsigned } })).rejects.toThrow()
  await expect(f.run({ ...f.calls.prepare, verified: true })).rejects.toThrow()
  const originalPeer = f.options.peer
  f.options.peer = { ...f.options.peer, processNonce: Buffer.alloc(32, 4).toString('base64url') }
  await expect(f.run(f.calls.prepare)).rejects.toThrow()
  f.options.peer = originalPeer
  f.time.value = f.calls.prepare.directive.expiresAt
  await expect(f.run(f.calls.prepare)).rejects.toThrow()
  expect(f.actions).toEqual([])
  expect(f.claimed).toEqual([])
})

it('rejects a retained proposal for an old Account binding before the start action', async () => {
  const f = await fixture(), changed = { ...f.ready, accountBindingId: 'old-binding', signature: unsigned }
  const proposal = { ...changed, signature: f.cloudSign(encodeHostTaskReadyAdmissionDirective(changed)) }
  f.original({ kind: 'task_target_original', proposal, challenge: f.challenge })
  await expect(f.run(f.calls.start)).rejects.toThrow()
  expect(f.actions).toEqual(['task_target'])
  expect(f.signatures()).toBe(0)
})

it('rejects forged original Cloud/installation pairs before the start action', async () => {
  for (const field of ['proposal', 'challenge'] as const) {
    const f = await fixture()
    f.original({ kind: 'task_target_original', proposal: field === 'proposal' ? { ...f.ready, signature: unsigned } : f.ready,
      challenge: field === 'challenge' ? f.challenge : { ...f.challenge, signature: f.hostSign(encodeHostTaskTargetConsumeChallenge(f.challenge)) } })
    await expect(f.run(f.calls.start)).rejects.toThrow()
    expect(f.actions).toEqual(['task_target'])
  }
})

it('does not commit after cancellation, current Account revocation or captured worker replacement during the read', async () => {
  for (const cause of ['cancel', 'revoke', 'replace', 'expire']) {
    const f = await fixture(), controller = new AbortController()
    f.intercept(async () => {
      if (cause === 'cancel') controller.abort(Error('original request cancelled'))
      if (cause === 'revoke') f.host.revokeOwner(f.account.ownerId)
      if (cause === 'replace') f.replace()
      if (cause === 'expire') f.time.value += 15000
      return { kind: 'task_target', record: { ok: true, peer: f.peer, record: { status: 'prepared', descriptor: f.descriptor } } }
    })
    await expect(f.run(f.calls.prepare, controller.signal)).rejects.toThrow()
    expect(f.actions).toEqual(['task_target'])
    expect(f.signatures()).toBe(0)
  }
})

it('refuses mismatched worker metadata or altered commit results and never returns an unpersisted signature', async () => {
  const f = await fixture()
  f.intercept(async command => ({ kind: 'task_target', record: { ok: true, peer: f.peer, record: { status: 'prepared', descriptor:
    command.action === 'task_target' ? f.descriptor : { ...f.descriptor, signature: unsigned } } } }))
  await expect(f.run(f.calls.prepare)).rejects.toThrow()
  expect(f.actions).toEqual(['task_target', 'task_target_commit'])
  expect(f.signatures()).toBe(1)
  const g = await fixture()
  g.intercept(async () => ({ kind: 'task_target', record: { ok: true, peer: g.peer, record: { status: 'consume_intent',
    challenge: { ...g.challenge, target: { ...g.challenge.target, workerId: 'another-worker' } } } } }))
  await expect(g.run(g.calls.ready)).rejects.toThrow()
  expect(g.signatures()).toBe(0)
})

it('contains signer failure and does not execute or publish a claimed body-complete result', async () => {
  const f = await fixture()
  f.options.sign = () => { throw Error('installation signer unavailable') }
  await expect(f.run(f.calls.prepare)).rejects.toThrow('signer unavailable')
  expect(f.actions).toEqual(['task_target'])
  const g = await fixture()
  g.intercept(async () => ({ kind: 'task_target', record: { ...g.recorded, record: { ...g.recorded.record, state: 'body_completed' } } }))
  await expect(g.run(g.calls.start)).rejects.toThrow()
  expect(g.actions).toEqual(['task_target'])
})


it('reuses a valid original installation signature without creating a new durable challenge or timestamp', async () => {
  const f = await fixture()
  const descriptor = { ...f.descriptor, signature: f.hostSign(encodeHostTaskTargetDescriptor(f.descriptor)) }
  f.intercept(async () => ({ kind: 'task_target', record: { ok: true, peer: f.peer,
    record: { status: 'prepared', descriptor } } }))
  expect(await f.run(f.calls.prepare)).toMatchObject({ ok: true, record: { descriptor } })
  expect(f.signatures()).toBe(0)
  expect(f.actions).toEqual(['task_target', 'task_target_commit'])
})

it('rechecks cancellation and Account ownership immediately after installation signing', async () => {
  const f = await fixture(), originalSign = f.options.sign
  f.options.sign = (bytes) => { const signed = originalSign(bytes); f.host.revokeOwner(f.account.ownerId); return signed }
  await expect(f.run(f.calls.ready)).rejects.toThrow()
  expect(f.actions).toEqual(['task_target'])
})

it('preserves exact read-only provider refusal and never treats a premature recorded reply as permission to start', async () => {
  const f = await fixture()
  f.intercept(async () => ({ kind: 'task_target', record: { ok: false, errorCode: 'unavailable' } }))
  expect(await f.run(f.calls.start)).toEqual({ ok: false, errorCode: 'unavailable' })
  expect(f.actions).toEqual(['task_target'])
  const g = await fixture()
  g.intercept(async () => ({ kind: 'task_target', record: g.recorded }))
  await expect(g.run(g.calls.start)).rejects.toThrow()
  expect(g.actions).toEqual(['task_target'])
})

it('rejects a different Account and a Source key outside its validity window without claiming a nonce', async () => {
  const f = await fixture()
  await expect(operateAccountTaskTarget(f.options, { ...f.account, accountBindingHandle: 'different-binding' },
    f.calls.prepare, 'actual-private-binding', new AbortController().signal)).rejects.toThrow()
  const environment = f.options.environments[0]
  if (!environment) throw Error('missing environment')
  f.options.environments = [{ ...environment, keyring: { ...environment.keyring, keys: environment.keyring.keys.map(key =>
    ({ ...key, validUntil: f.time.value })) } }]
  await expect(f.run(f.calls.prepare)).rejects.toThrow()
  expect(f.actions).toEqual([])
  expect(f.claimed).toEqual([])
})


it('validates the final durable reply after the independently checked original pair', async () => {
  const f = await fixture()
  f.intercept(async command => command.action === 'task_target'
    ? { kind: 'task_target_original', proposal: f.ready,
      challenge: { ...f.challenge, signature: f.hostSign(encodeHostTaskTargetConsumeChallenge(f.challenge)) } }
    : { kind: 'task_target', record: { ...f.recorded, record: { ...f.recorded.record, commandId: 'different-command' } } })
  await expect(f.run(f.calls.start)).rejects.toThrow()
  expect(f.actions).toEqual(['task_target', 'task_target_run', 'task_target_wait_claim'])
  expect(f.signatures()).toBe(0)
})

it('rechecks actual worker and Account before moving from the read-only original pair into start', async () => {
  for (const cause of ['replace', 'revoke']) {
    const f = await fixture()
    f.intercept(async () => {
      if (cause === 'replace') f.replace()
      else f.host.revokeOwner(f.account.ownerId)
      return { kind: 'task_target_original', proposal: f.ready,
        challenge: { ...f.challenge, signature: f.hostSign(encodeHostTaskTargetConsumeChallenge(f.challenge)) } }
    })
    await expect(f.run(f.calls.start)).rejects.toThrow()
    expect(f.actions).toEqual(['task_target'])
  }
})


it('keeps the actual Main Account registration after claim and unary detach until the long run settles', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), completed = Promise.withResolvers<unknown>()
  const unary = new AbortController(), runClosed = Promise.withResolvers<undefined>()
  let lifetime: AbortSignal | undefined
  f.intercept(async (command, signal) => {
    if (command.action === 'task_target') return { kind: 'task_target_original', proposal: f.ready,
      challenge: { ...f.challenge, signature: f.hostSign(encodeHostTaskTargetConsumeChallenge(f.challenge)) } }
    // The old one-stage implementation can return its Ack; this exposes the lost Account registration directly.
    if (command.action === 'task_target_start') { lifetime = signal; return { kind: 'task_target', record: f.recorded } }
    if (command.action === 'task_target_run') {
      lifetime = signal; entered.resolve(undefined)
      const stop = () =>{  completed.reject(signal.reason instanceof Error ? signal.reason : Error('owned request aborted')) }
      signal.addEventListener('abort', stop, { once: true })
      try { return await completed.promise }
      finally { signal.removeEventListener('abort', stop); runClosed.resolve(undefined) }
    }
    if (command.action !== 'task_target_wait_claim') throw Error('unexpected private action')
    await entered.promise
    return { kind: 'task_target', record: f.recorded }
  })
  const reply = await f.run(f.calls.start, unary.signal)
  expect(reply).toEqual(f.recorded)
  expect(lifetime?.aborted).toBe(false)
  f.host.revokeOwner(f.account.ownerId)
  expect(lifetime?.aborted).toBe(true)
  expect(f.actions).toEqual(['task_target', 'task_target_run', 'task_target_wait_claim'])
  await runClosed.promise
})

it('propagates pre-claim short cancellation while retaining Account ownership until actual worker cleanup', async () => {
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), waitEntered = Promise.withResolvers<undefined>()
  const completed = Promise.withResolvers<unknown>(), runClosed = Promise.withResolvers<undefined>(), unary = new AbortController()
  let lifetime: AbortSignal | undefined, short: AbortSignal | undefined
  f.intercept(async (command, signal) => {
    if (command.action === 'task_target') return { kind: 'task_target_original', proposal: f.ready,
      challenge: { ...f.challenge, signature: f.hostSign(encodeHostTaskTargetConsumeChallenge(f.challenge)) } }
    if (command.action === 'task_target_run') {
      lifetime = signal; entered.resolve(undefined)
      const stop = () =>{  completed.reject(signal.reason instanceof Error ? signal.reason : Error('owned request aborted')) }
      signal.addEventListener('abort', stop, { once: true })
      try { return await completed.promise }
      finally { signal.removeEventListener('abort', stop); runClosed.resolve(undefined) }
    }
    if (command.action !== 'task_target_wait_claim') throw Error('unexpected private action')
    await entered.promise; short = signal; waitEntered.resolve(undefined)
    return await new Promise((_, reject) => {
      if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : Error('owned request aborted')); return }
      signal.addEventListener('abort', () =>{  reject(signal.reason instanceof Error ? signal.reason : Error('owned request aborted')) }, { once: true })
    })
  })
  const operation = f.run(f.calls.start, unary.signal), rejected = expect(operation).rejects.toThrow('cancel before claim')
  await waitEntered.promise
  unary.abort(Error('cancel before claim'))
  await rejected
  expect(short?.aborted).toBe(true)
  expect(lifetime?.aborted).toBe(false)
  // A failed short waiter cannot release Account control while the actual worker is still cleaning up.
  f.host.revokeOwner(f.account.ownerId)
  expect(lifetime?.aborted).toBe(true)
  await runClosed.promise
})

it('does not use the admission expiry as a claimed task duration limit and releases registration after completion', async () => {
  const unary = new AbortController()
  const f = await fixture(), entered = Promise.withResolvers<undefined>(), completed = Promise.withResolvers<unknown>()
  const runClosed = Promise.withResolvers<undefined>()
  let lifetime: AbortSignal | undefined
  f.intercept(async (command, signal) => {
    if (command.action === 'task_target') return { kind: 'task_target_original', proposal: f.ready,
      challenge: { ...f.challenge, signature: f.hostSign(encodeHostTaskTargetConsumeChallenge(f.challenge)) } }
    if (command.action === 'task_target_run') {
      lifetime = signal; entered.resolve(undefined)
      try { return await completed.promise } finally { runClosed.resolve(undefined) }
    }
    if (command.action !== 'task_target_wait_claim') throw Error('unexpected private action')
    await entered.promise
    return { kind: 'task_target', record: f.recorded }
  })
  expect(await f.run(f.calls.start, unary.signal)).toEqual(f.recorded)
  unary.abort(Error('short request finished after claim'))
  f.time.value = f.receipt.expiresAt + 60000
  expect(lifetime?.aborted).toBe(false)
  completed.resolve({ kind: 'task_target', record: { ...f.recorded, record: { ...f.recorded.record, state: 'settled' } } })
  await runClosed.promise
  // Let the actual Account callback and its finally finish, rather than inspecting a private map.
  await new Promise<void>(resolve => setImmediate(resolve))
  f.host.revokeOwner(f.account.ownerId)
  expect(lifetime?.aborted).toBe(false)
})

it('rejects expired ready_start tickets before creating either background action', async () => {
  const f = await fixture()
  f.time.value = f.receipt.expiresAt
  await expect(f.run(f.calls.start)).rejects.toThrow()
  expect(f.actions).toEqual([])
  expect(f.claimed).toEqual([])
})


it('observes a background run failure while the short claim waiter is still pending', async () => {
  const f = await fixture(), waitClosed = Promise.withResolvers<undefined>()
  let lifetime: AbortSignal | undefined
  f.intercept(async (command, signal) => {
    if (command.action === 'task_target') return { kind: 'task_target_original', proposal: f.ready,
      challenge: { ...f.challenge, signature: f.hostSign(encodeHostTaskTargetConsumeChallenge(f.challenge)) } }
    if (command.action === 'task_target_run') { lifetime = signal; throw Error('actual run lost before claim reply') }
    if (command.action !== 'task_target_wait_claim') throw Error('unexpected private action')
    try {
      return await new Promise((_, reject) => {
        if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : Error('owned request aborted')); return }
        signal.addEventListener('abort', () =>{  reject(signal.reason instanceof Error ? signal.reason : Error('owned request aborted')) }, { once: true })
      })
    } finally { waitClosed.resolve(undefined) }
  })
  await expect(f.run(f.calls.start)).rejects.toThrow('actual run lost before claim reply')
  // Even this ordering keeps the actual Account callback until its other in-flight worker request closes.
  f.host.revokeOwner(f.account.ownerId)
  expect(lifetime?.aborted).toBe(true)
  await waitClosed.promise
})
