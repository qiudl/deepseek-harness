import { describe, expect, it } from 'vitest'
import { createWindowsHostPipeWorkerBootData } from '../src/windows-host-pipe-worker-boot.ts'
import {
  createWindowsHostPipeSlotBootData,
  decodeWindowsHostPipeSlotBootData,
} from '../src/windows-host-pipe-slot-boot.ts'
import { resolveWindowsNamedPipePolicy } from '../src/windows-named-pipe-policy.ts'
import { HostAuthorityError } from '../src/types.ts'
import { createWindowsWorkerStopFlag } from '../src/windows-worker-io-cancellation.ts'

const publisher = 'A'.repeat(64)
const digest = 'b'.repeat(64)
const nativeModule = Object.freeze({
  path: String.raw`C:\Program Files\Slark\resources\dsh\native\win32-x64\koffi.node`,
  sha256: 'c'.repeat(64),
})
const diagnosticsRoot = String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host`
const policy = resolveWindowsNamedPipePolicy({
  installationId: 'installation-1',
  endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
  userSid: 'S-1-5-21-1000-2000-3000-1001',
})

function generationBoot() {
  return createWindowsHostPipeWorkerBootData({
    generation: 7,
    policy,
    stopFlag: createWindowsWorkerStopFlag(),
    allowedPublisherThumbprints: new Set([publisher]),
    allowedExecutableDigests: new Set([digest]),
    nativeModule,
    diagnosticsRoot,
  })
}

describe('Windows Host pipe slot boot data', () => {
  it('derives one canonical slot payload from the generation boot data', () => {
    const flag = createWindowsWorkerStopFlag()
    expect(createWindowsHostPipeSlotBootData(generationBoot(), false, flag)).toEqual({
      version: 1,
      role: 'slot',
      generation: 7,
      firstInstance: false,
      policy,
      stopFlagBuffer: flag.buffer,
      allowedPublisherThumbprints: [publisher],
      allowedExecutableDigests: [digest],
      nativeModule,
      diagnosticsRoot,
    })
  })

  it('rejects non-canonical, extra, and malformed slot boot fields', () => {
    const valid = createWindowsHostPipeSlotBootData(
      generationBoot(),
      true,
      createWindowsWorkerStopFlag(),
    )
    for (const invalid of [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, role: 'router' },
      { ...valid, generation: 0 },
      { ...valid, firstInstance: 'yes' },
      { ...valid, stopFlagBuffer: new SharedArrayBuffer(8) },
      { ...valid, allowedPublisherThumbprints: [] },
      { ...valid, policy: { ...policy, maxInstances: 1 } },
      { ...valid, policy: { ...policy, openMode: 0x0000_0003 } },
      { ...valid, diagnosticsRoot: '/var/lib/slark' },
    ]) {
      expect(() => decodeWindowsHostPipeSlotBootData(invalid))
        .toThrow('Invalid Windows Host Worker boot data')
    }
  })

  it('keeps the slot payload tied to the generation stop flag buffer', () => {
    const flag = createWindowsWorkerStopFlag()
    const boot = createWindowsHostPipeSlotBootData(generationBoot(), true, flag)
    flag.request()
    expect(boot.stopFlagBuffer.byteLength).toBe(4)
    expect(new Int32Array(boot.stopFlagBuffer)[0]).toBe(1)
  })

  it('maps a structurally invalid generation payload onto the public authority error', () => {
    expect(() => createWindowsHostPipeSlotBootData(
      { ...generationBoot(), generation: 0 },
      true,
      createWindowsWorkerStopFlag(),
    )).toThrow(HostAuthorityError)
  })
})
