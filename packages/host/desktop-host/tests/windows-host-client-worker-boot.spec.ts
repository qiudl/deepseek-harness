import { describe, expect, it } from 'vitest'
import { HostAuthorityError } from '../src/index.ts'
import {
  createWindowsHostClientWorkerBootData,
  decodeWindowsHostClientWorkerBootData,
} from '../src/windows-host-client-worker-boot.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

const pipePath = String.raw`\\.\pipe\slark-dsh-host-v1-${'a'.repeat(64)}`
const publisher = 'A'.repeat(64)
const digest = 'b'.repeat(64)

describe('Windows Host client Worker boot data', () => {
  it('creates one immutable exact trust payload for structured clone', () => {
    const stopFlag = createWindowsWorkerStopFlag()
    const boot = createWindowsHostClientWorkerBootData({
      generation: 7,
      pipePath,
      stopFlag,
      connectTimeoutMs: 5_000,
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([digest]),
    })
    expect(boot).toEqual({
      version: 1,
      generation: 7,
      pipePath,
      stopFlagBuffer: stopFlag.buffer,
      connectTimeoutMs: 5_000,
      allowedPublisherThumbprints: [publisher],
      allowedPackageFamilyNames: [],
      allowedExecutableDigests: [digest],
    })
    expect(Object.isFrozen(boot)).toBe(true)
    expect(Object.isFrozen(boot.allowedPublisherThumbprints)).toBe(true)
  })

  it('rejects unknown fields, malformed anchors, paths, timeouts, and stop flags', () => {
    const valid = {
      version: 1,
      generation: 7,
      pipePath,
      stopFlagBuffer: new SharedArrayBuffer(4),
      connectTimeoutMs: 5_000,
      allowedPublisherThumbprints: [publisher],
      allowedExecutableDigests: [digest],
    }
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, generation: 0 },
      { ...valid, pipePath: String.raw`\\.\pipe\other` },
      { ...valid, stopFlagBuffer: new SharedArrayBuffer(8) },
      { ...valid, connectTimeoutMs: 0 },
      { ...valid, connectTimeoutMs: 30_001 },
      { ...valid, allowedPublisherThumbprints: [] },
      { ...valid, allowedPublisherThumbprints: ['B'.repeat(64), publisher] },
      { ...valid, allowedExecutableDigests: ['not-a-digest'] },
    ]) expect(() => decodeWindowsHostClientWorkerBootData(invalid)).toThrow()
  })

  it('maps caller mistakes to invalid_input at the authority boundary', () => {
    expect(() => createWindowsHostClientWorkerBootData({
      generation: 1,
      pipePath,
      stopFlag: createWindowsWorkerStopFlag(),
      connectTimeoutMs: 0,
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([digest]),
    })).toThrow(HostAuthorityError)
  })
})
