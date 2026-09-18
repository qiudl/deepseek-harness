import { describe, expect, it } from 'vitest'
import { LegacyClaimCoordinator } from '../src/legacy-claim-coordinator.ts'
import { LegacyClaimLedger, type LegacyClaimEvent } from '../src/legacy-claim-ledger.ts'
import { ProfileClaimMarker } from '../src/legacy-claim-marker.ts'
import { LegacyClaimRecoveryStore } from '../src/legacy-claim-recovery.ts'
import { LegacyClaimTarget } from '../src/legacy-claim-target.ts'

const profileId = 'b9e8b0aa-5c8e-4d4c-8e7a-139a86985f41'
const otherProfileId = '36ab1d8e-c9fd-4b3a-9b9f-646e2dd6d469'
const operationId = '97086a03-9508-41c0-bec3-7464dc835953'
const candidateId = 'llm-deepseek:deepseek'
const sourceDigest = 'a'.repeat(64)

function fixture() {
  const events: LegacyClaimEvent[] = []
  const ledger = new LegacyClaimLedger({
    read: () => events,
    append: (event) => { events.push(event) },
  }, () => 1)
  const markers = new Map<string, Buffer>()
  let failClearMarker = false
  let failMarkAfterPublish = false
  const marker = new ProfileClaimMarker({
    read: profile => markers.get(profile),
    replace: (profile, bytes) => {
      const state = (JSON.parse(bytes.toString()) as { state: string }).state
      if (failClearMarker && state === 'cleared') {
        failClearMarker = false
        throw Error('marker_clear_interrupted')
      }
      markers.set(profile, Buffer.from(bytes))
      if (failMarkAfterPublish && state === 'pending') {
        failMarkAfterPublish = false
        throw Error('marker_mark_interrupted')
      }
    },
  })
  const snapshots = new Map<string, Buffer>()
  let failRemove = false
  const recovery = new LegacyClaimRecoveryStore({
    read: (_profile, operation) => snapshots.get(operation),
    replace: (_profile, operation, bytes) => { snapshots.set(operation, Buffer.from(bytes)) },
    remove: (_profile, operation, expected, guard) => {
      guard()
      if (failRemove) throw Error('cleanup_interrupted')
      if (!snapshots.get(operation)?.equals(expected)) throw Error('snapshot_changed')
      snapshots.delete(operation)
    },
  })
  let settings = Buffer.from('{"ui":{"theme":"dark"}}\n')
  let credentials = Buffer.from('{"version":1,"refs":{"PERSONAL":"personal-secret"},"records":{}}\n')
  let failSettings = false
  let onCredentialWrite: (() => void) | undefined
  let generation = 1
  let generationSequence: number[] = []
  let workerRunning = true
  let sourceReads = 0
  let sourceGate: Promise<void> | undefined
  let releaseSource: (() => void) | undefined
  let stopCount = 0
  let startCount = 0
  const target = new LegacyClaimTarget({
    read: kind => Buffer.from(kind === 'settings' ? settings : credentials),
    replace: (kind, bytes) => {
      if (kind === 'settings' && failSettings) throw Error('settings_interrupted')
      if (kind === 'settings') settings = Buffer.from(bytes)
      else { credentials = Buffer.from(bytes); onCredentialWrite?.() }
    },
  }, recovery)
  const coordinator = new LegacyClaimCoordinator({
    ledger, marker, recovery,
    readSource: async () => {
      sourceReads += 1
      await sourceGate
      return {
        sourceDigest,
        settings: { 'llm-deepseek': { apiKeyEnv: 'OLD_KEY' }, permission: { mode: 'unsafe' } },
        credentials: { refs: { OLD_KEY: 'legacy-secret' }, records: {} },
      }
    },
    targetGeneration: async () => generationSequence.shift() ?? generation,
    target: () => target,
    stopWorker: async () => { stopCount += 1; workerRunning = false },
    startWorker: async () => { startCount += 1; workerRunning = true },
  })
  const claim = { candidateId, operationId, expectedSourceDigest: sourceDigest,
    authorizeAccountProfile: () => profileId }
  const restore = { candidateId, operationId, authorizeAccountProfile: () => profileId }
  return {
    coordinator, ledger, marker, recovery, claim, restore, events, markers, snapshots,
    current: () => ({ settings, credentials }),
    running: () => workerRunning,
    sourceReads: () => sourceReads,
    stops: () => stopCount,
    starts: () => startCount,
    failSettings: (value: boolean) => { failSettings = value },
    onCredentialWrite: (callback: () => void) => { onCredentialWrite = callback },
    failClearMarker: () => { failClearMarker = true },
    failMarkAfterPublish: () => { failMarkAfterPublish = true },
    failRemove: (value: boolean) => { failRemove = value },
    generation: (value: number) => { generation = value },
    generationSequence: (values: number[]) => { generationSequence = values },
    holdSource: () => {
      sourceGate = new Promise<void>((resolve) => { releaseSource = resolve })
    },
    releaseSource: () => { releaseSource?.(); sourceGate = undefined },
  }
}

describe('Host-internal legacy claim transaction order', () => {
  it('exposes only an owned durable receipt and refuses an unreserved retry', async () => {
    const state = fixture()
    expect(state.coordinator.status({ candidateId, authorizeAccountProfile: () => profileId })).toBeNull()
    expect(() => { state.coordinator.retry(state.claim) }).toThrow(/conflict/u)
    expect(state.sourceReads()).toBe(0)
    state.failSettings(true)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('settings_interrupted')
    expect(state.coordinator.status({ candidateId, authorizeAccountProfile: () => profileId }))
      .toEqual({ candidateId, operationId, sourceDigest, status: 'pending' })
    expect(state.coordinator.pendingReceipts({ authorizeAccountProfile: () => profileId }))
      .toEqual([{ candidateId, operationId, sourceDigest, status: 'pending' }])
    expect(state.coordinator.pendingReceipts({ authorizeAccountProfile: () => otherProfileId })).toEqual([])
    expect(() => { state.coordinator.status({ candidateId, authorizeAccountProfile: () => otherProfileId }) })
      .toThrow(/conflict/u)
    expect(() => { state.coordinator.retry({ ...state.claim, operationId: '2a2ec924-9005-4bcd-ae53-aa8f4f74fcf3' }) })
      .toThrow(/conflict/u)
    expect(() => { state.coordinator.retry({ ...state.claim, expectedSourceDigest: 'b'.repeat(64) }) })
      .toThrow(/conflict/u)
    state.failSettings(false)
    expect(await state.coordinator.retry(state.claim)).toEqual({ state: 'committed', cleanupPending: false })
    expect(state.coordinator.status({ candidateId, authorizeAccountProfile: () => profileId })?.status)
      .toBe('committed')
    expect(state.coordinator.pendingReceipts({ authorizeAccountProfile: () => profileId })).toEqual([])
  })

  it('retains a restored receipt only while its marker still needs recovery', async () => {
    const state = fixture()
    state.failSettings(true)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('settings_interrupted')
    state.failSettings(false)
    state.failClearMarker()
    await expect(state.coordinator.restore(state.restore)).rejects.toThrow('marker_clear_interrupted')
    expect(state.coordinator.status({ candidateId, authorizeAccountProfile: () => profileId })?.status)
      .toBe('restored')
    expect(state.coordinator.pendingReceipts({ authorizeAccountProfile: () => profileId }))
      .toEqual([{ candidateId, operationId, sourceDigest, status: 'restored' }])
    expect(() => { state.coordinator.retry(state.claim) }).toThrow(/conflict/u)
    await state.coordinator.restore(state.restore)
    expect(state.coordinator.status({ candidateId, authorizeAccountProfile: () => profileId })).toBeNull()
    expect(state.coordinator.pendingReceipts({ authorizeAccountProfile: () => profileId })).toEqual([])
  })

  it('rejects a marker without its exact durable operation', () => {
    const state = fixture()
    state.marker.mark({ profileId, candidateId, operationId })
    expect(() => state.coordinator.pendingReceipts({ authorizeAccountProfile: () => profileId }))
      .toThrow(/unavailable/u)
    state.ledger.reserve({ profileId, candidateId, operationId: 'different-operation',
      sourceDigest, targetGeneration: 1 })
    expect(() => state.coordinator.pendingReceipts({ authorizeAccountProfile: () => profileId }))
      .toThrow(/unavailable/u)
  })

  it('rejects a recovery list over the wire limit after adding a committed marker', async () => {
    const state = fixture()
    state.failClearMarker()
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('marker_clear_interrupted')
    for (let index = 0; index < 128; index += 1) {
      state.ledger.reserve({ profileId, candidateId: `llm-pi-ai:provider-${index}`,
        operationId: `operation-${index}`, sourceDigest, targetGeneration: 1 })
    }
    expect(() => state.coordinator.pendingReceipts({ authorizeAccountProfile: () => profileId }))
      .toThrow(/unavailable/u)
  })

  it('commits one provider only after both target files verify, then restarts the worker', async () => {
    const state = fixture()
    expect(await state.coordinator.claim(state.claim)).toEqual({ state: 'committed', cleanupPending: false })
    expect(state.ledger.status(candidateId, profileId)?.status).toBe('committed')
    expect(state.marker.pending(profileId)).toBe(false)
    expect(state.snapshots.size).toBe(0)
    expect(state.running()).toBe(true)
    expect(state.current().settings.toString()).not.toContain('legacy-secret')
    expect(state.current().settings.toString()).not.toContain('permission')
    expect(state.current().credentials.toString()).toContain('legacy-secret')
    expect(await state.coordinator.claim(state.claim)).toEqual({ state: 'committed', cleanupPending: false })
    expect(state.sourceReads()).toBe(1)
    expect(state.stops()).toBe(1)
    expect(state.starts()).toBe(2)
  })

  it('keeps only the affected worker fenced after a partial write, then retries', async () => {
    const state = fixture()
    state.failSettings(true)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('settings_interrupted')
    expect(state.ledger.hasPending(profileId)).toBe(true)
    expect(state.marker.pending(profileId)).toBe(true)
    expect(state.running()).toBe(false)
    expect(state.snapshots.size).toBe(1)
    state.failSettings(false)
    await expect(state.coordinator.claim({ ...state.claim, authorizeAccountProfile: () => otherProfileId }))
      .rejects.toThrow(/conflict/u)
    expect(await state.coordinator.claim(state.claim)).toEqual({ state: 'committed', cleanupPending: false })
    expect(state.running()).toBe(true)
    expect(state.snapshots.size).toBe(0)
  })

  it('recovers a committed result after marker-clear interruption without rereading source', async () => {
    const state = fixture()
    state.failClearMarker()
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('marker_clear_interrupted')
    expect(state.ledger.status(candidateId, profileId)?.status).toBe('committed')
    expect(state.marker.pending(profileId)).toBe(true)
    expect(state.running()).toBe(false)
    expect(state.coordinator.pendingReceipts({ authorizeAccountProfile: () => profileId }))
      .toEqual([{ candidateId, operationId, sourceDigest, status: 'committed' }])
    expect(await state.coordinator.claim(state.claim)).toEqual({ state: 'committed', cleanupPending: false })
    expect(state.sourceReads()).toBe(1)
    expect(state.running()).toBe(true)
  })

  it('keeps a committed marker fenced if the active target generation changed', async () => {
    const state = fixture()
    state.failClearMarker()
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('marker_clear_interrupted')
    state.generation(2)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow(/stale/u)
    expect(state.marker.pending(profileId)).toBe(true)
    expect(state.running()).toBe(false)
    expect(state.sourceReads()).toBe(1)
  })

  it('restores an interrupted target pair and survives restoration retry', async () => {
    const state = fixture()
    const before = state.current()
    state.failSettings(true)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('settings_interrupted')
    state.failSettings(false)
    expect(await state.coordinator.restore(state.restore)).toEqual({ state: 'restored', cleanupPending: false })
    expect(state.current()).toEqual(before)
    expect(state.marker.pending(profileId)).toBe(false)
    expect(state.ledger.status(candidateId, profileId)).toBeNull()
    expect(await state.coordinator.restore(state.restore)).toEqual({ state: 'restored', cleanupPending: false })
  })

  it('keeps an interrupted target fenced if its active generation changed before restore', async () => {
    const state = fixture()
    state.failSettings(true)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('settings_interrupted')
    state.generation(2)
    await expect(state.coordinator.restore(state.restore)).rejects.toThrow(/stale/u)
    expect(state.marker.pending(profileId)).toBe(true)
    expect(state.running()).toBe(false)
  })

  it('reports cleanup pending without withholding a committed Profile', async () => {
    const state = fixture()
    state.failRemove(true)
    expect(await state.coordinator.claim(state.claim)).toEqual({ state: 'committed', cleanupPending: true })
    expect(state.running()).toBe(true)
    expect(state.snapshots.size).toBe(1)
    state.failRemove(false)
    expect(await state.coordinator.claim(state.claim)).toEqual({ state: 'committed', cleanupPending: false })
    expect(state.snapshots.size).toBe(0)
  })

  it('rejects stale authority, malformed confirmation, and changed source before a worker stop', async () => {
    const state = fixture()
    let calls = 0
    await expect(state.coordinator.claim({ ...state.claim, authorizeAccountProfile: () => {
      calls += 1
      return calls === 1 ? profileId : otherProfileId
    } })).rejects.toThrow(/profile_mismatch/u)
    await expect(state.coordinator.claim({ ...state.claim, expectedSourceDigest: 'bad' }))
      .rejects.toThrow(/invalid_input/u)
    await expect(state.coordinator.claim({ ...state.claim, expectedSourceDigest: 'b'.repeat(64) }))
      .rejects.toThrow(/conflict/u)
    expect(state.stops()).toBe(0)
  })

  it('restarts an untouched worker when generation changes before reservation', async () => {
    const state = fixture()
    state.generationSequence([1, 2])
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow(/stale/u)
    expect(state.running()).toBe(true)
    expect(state.marker.pending(profileId)).toBe(false)
    expect(state.ledger.ownerState(candidateId, profileId)).toBeNull()
    expect(state.snapshots.size).toBe(0)
  })

  it('retains the marker if its publication outcome is uncertain', async () => {
    const state = fixture()
    state.failMarkAfterPublish()
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('marker_mark_interrupted')
    expect(state.marker.pending(profileId)).toBe(true)
    expect(state.running()).toBe(false)
    expect(state.ledger.hasPending(profileId)).toBe(true)
    expect(await state.coordinator.claim(state.claim)).toEqual({ state: 'committed', cleanupPending: false })
  })

  it('requires the original operation and recovery bytes for a committed marker retry', async () => {
    const state = fixture()
    state.failClearMarker()
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('marker_clear_interrupted')
    await expect(state.coordinator.claim({ ...state.claim, operationId: '2a2ec924-9005-4bcd-ae53-aa8f4f74fcf3' }))
      .rejects.toThrow(/idempotency_conflict/u)
    state.snapshots.delete(operationId)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow(/unavailable/u)
    expect(state.marker.pending(profileId)).toBe(true)
  })

  it('refuses restoration of unowned, completed, or missing-preimage operations', async () => {
    const state = fixture()
    await expect(state.coordinator.restore(state.restore)).rejects.toThrow(/conflict/u)
    state.failSettings(true)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('settings_interrupted')
    await expect(state.coordinator.restore({ ...state.restore, operationId: '2a2ec924-9005-4bcd-ae53-aa8f4f74fcf3' }))
      .rejects.toThrow(/conflict/u)
    state.snapshots.delete(operationId)
    await expect(state.coordinator.restore(state.restore)).rejects.toThrow(/unavailable/u)
    expect(state.marker.pending(profileId)).toBe(true)
  })

  it('finishes a restored marker after a clear interruption', async () => {
    const state = fixture()
    state.failSettings(true)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('settings_interrupted')
    state.failSettings(false)
    state.failClearMarker()
    await expect(state.coordinator.restore(state.restore)).rejects.toThrow('marker_clear_interrupted')
    expect(state.ledger.ownerState(candidateId, profileId)?.status).toBe('restored')
    expect(state.marker.pending(profileId)).toBe(true)
    expect(await state.coordinator.restore(state.restore)).toEqual({ state: 'restored', cleanupPending: false })
    expect(state.running()).toBe(true)
  })

  it('rejects a new reservation while another operation owns the Profile marker', async () => {
    const state = fixture()
    state.failSettings(true)
    await expect(state.coordinator.claim(state.claim)).rejects.toThrow('settings_interrupted')
    await expect(state.coordinator.claim({ ...state.claim,
      candidateId: 'web-search-deepseek:deepseek', operationId: '2a2ec924-9005-4bcd-ae53-aa8f4f74fcf3',
    })).rejects.toThrow(/conflict/u)
    expect(state.events.filter(event => event.kind === 'reserved')).toHaveLength(1)
  })

  it('serializes two requests for the same Profile', async () => {
    const state = fixture()
    state.holdSource()
    const first = state.coordinator.claim(state.claim)
    await Promise.resolve()
    const second = state.coordinator.claim(state.claim)
    expect(state.sourceReads()).toBe(1)
    state.releaseSource()
    expect(await first).toEqual({ state: 'committed', cleanupPending: false })
    expect(await second).toEqual({ state: 'committed', cleanupPending: false })
    expect(state.sourceReads()).toBe(1)
    expect(state.stops()).toBe(1)
  })

  it('keeps the Profile pending if Account view authority is revoked between writes', async () => {
    const state = fixture()
    let authorized = true
    state.onCredentialWrite(() => { authorized = false })
    await expect(state.coordinator.claim({ ...state.claim,
      authorizeAccountProfile: () => authorized ? profileId : otherProfileId,
    })).rejects.toThrow(/profile_mismatch/u)
    expect(state.marker.pending(profileId)).toBe(true)
    expect(state.running()).toBe(false)
    expect(state.ledger.hasPending(profileId)).toBe(true)
    expect(state.current().credentials.toString()).toContain('legacy-secret')
    expect(state.current().settings.toString()).not.toContain('llm-deepseek')
  })
})
