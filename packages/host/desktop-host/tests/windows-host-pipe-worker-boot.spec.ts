import { describe, expect, it } from 'vitest'
import {
  createWindowsHostPipeWorkerBootData,
  decodeWindowsHostPipeWorkerBootData,
} from '../src/windows-host-pipe-worker-boot.ts'
import { resolveWindowsNamedPipePolicy } from '../src/windows-named-pipe-policy.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

const publisher = 'A'.repeat(64)
const digest = 'b'.repeat(64)
const nativeModule = Object.freeze({
  path: String.raw`C:\Program Files\Slark\resources\dsh\native\win32-x64\koffi.node`,
  sha256: 'c'.repeat(64),
})
const policy = resolveWindowsNamedPipePolicy({
  installationId: 'installation-1',
  endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
  userSid: 'S-1-5-21-1000-2000-3000-1001',
})

describe('Windows Host pipe Worker boot data', () => {
  it('creates one canonical structured-clone payload with the shared stop flag', () => {
    const flag = createWindowsWorkerStopFlag()
    expect(createWindowsHostPipeWorkerBootData({
      generation: 7,
      policy,
      stopFlag: flag,
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([digest]),
      nativeModule,
    })).toEqual({
      version: 1,
      generation: 7,
      policy,
      stopFlagBuffer: flag.buffer,
      allowedPublisherThumbprints: [publisher],
      allowedExecutableDigests: [digest],
      nativeModule,
    })
  })

  it('rejects non-canonical, extra, empty, and malformed boot fields', () => {
    const valid = createWindowsHostPipeWorkerBootData({
      generation: 7,
      policy,
      stopFlag: createWindowsWorkerStopFlag(),
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([digest]),
      nativeModule,
    })
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, generation: 0 },
      { ...valid, stopFlagBuffer: new SharedArrayBuffer(8) },
      { ...valid, allowedPublisherThumbprints: [] },
      { ...valid, allowedPublisherThumbprints: [publisher.toLowerCase()] },
      { ...valid, allowedExecutableDigests: [digest.toUpperCase()] },
      { ...valid, nativeModule: { ...nativeModule, path: 'koffi.node' } },
      { ...valid, nativeModule: { ...nativeModule, sha256: 'C'.repeat(64) } },
      { ...valid, policy: { ...policy, maxInstances: 2 } },
      { ...valid, policy: { ...policy, path: String.raw`\\.\pipe\other` } },
      { ...valid, policy: { ...policy, securityDescriptor: 'D:(A;;GA;;;WD)' } },
    ]) {
      expect(() => decodeWindowsHostPipeWorkerBootData(invalid)).toThrow('Invalid Windows Host Worker boot data')
    }
  })
})
