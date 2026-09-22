import { describe, expect, it } from 'vitest'
import { HostAuthorityError } from '../src/index.ts'
import {
  resolveWindowsNamedPipePolicy,
  windowsNamedPipePath,
} from '../src/windows-named-pipe-policy.ts'

const installationId = 'slark-dsh-e3a7a33ed99e8ce5b4d3522d96336dffa8da2820'
const endpointRegistrationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122'
const userSid = 'S-1-5-21-1000-2000-3000-1001'

describe('Windows named-pipe policy', () => {
  it('derives one opaque local pipe name from both installation identities', () => {
    const path = windowsNamedPipePath({ installationId, endpointRegistrationId })
    expect(path).toMatch(/^\\\\\.\\pipe\\slark-dsh-host-v1-[0-9a-f]{64}$/u)
    expect(path).not.toContain(installationId)
    expect(path).not.toContain(endpointRegistrationId)
    expect(windowsNamedPipePath({ installationId, endpointRegistrationId })).toBe(path)
    expect(windowsNamedPipePath({ installationId, endpointRegistrationId: endpointRegistrationId.replace(/2$/u, '3') }))
      .not.toBe(path)
  })

  it('builds a protected DACL granting pipe read/write only to the current user SID', () => {
    expect(resolveWindowsNamedPipePolicy({ installationId, endpointRegistrationId, userSid })).toEqual({
      path: windowsNamedPipePath({ installationId, endpointRegistrationId }),
      securityDescriptor: `O:${userSid}D:P(A;;GRGW;;;${userSid})`,
      openMode: 0x0008_0003,
      pipeMode: 0x0000_0008,
      maxInstances: 1,
    })
  })

  it('rejects broad principals and malformed identity inputs', () => {
    for (const rejectedSid of ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', `${userSid})(A;;GA;;;WD`]) {
      expect(() => resolveWindowsNamedPipePolicy({ installationId, endpointRegistrationId, userSid: rejectedSid }))
        .toThrow(HostAuthorityError)
    }
    expect(() => windowsNamedPipePath({ installationId: '../other', endpointRegistrationId }))
      .toThrow(HostAuthorityError)
    expect(() => windowsNamedPipePath({ installationId, endpointRegistrationId: 'not-a-uuid' }))
      .toThrow(HostAuthorityError)
  })
})
