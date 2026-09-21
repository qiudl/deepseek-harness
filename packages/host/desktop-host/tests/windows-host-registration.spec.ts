import { describe, expect, it, vi } from 'vitest'
import { HostAuthorityError } from '../src/index.ts'
import type { WindowsHostRegistration } from '../src/windows-host-carrier.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  WindowsHostRegistrationPublisher,
  WindowsHostPrivateLeaseConflictError,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostPrivatePathEvidence,
  type WindowsHostRegistrationFileBindings,
} from '../src/windows-host-registration.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host`
const registrationPath = String.raw`C:\Users\alice\AppData\Local\Slark\dsh-host\registration.v1.json`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
const registration: WindowsHostRegistration = Object.freeze({
  schema_version: 1,
  endpoint_registration_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3126',
  socket_path: String.raw`\\.\pipe\slark-dsh-host-v1-deadbeef`,
  installation_id: 'slark-dsh-d3a7a33ed99e8ce5b4d3522d96336dffa8da2820',
  installation_public_key: 'A'.repeat(43),
  executable_signature_digest: '1'.repeat(64),
})

function evidence(kind: 'directory' | 'file', overrides: Partial<WindowsHostPrivatePathEvidence> = {}): WindowsHostPrivatePathEvidence {
  return {
    kind,
    reparsePoint: false,
    linkCount: 1,
    ownerSid: userSid,
    daclProtected: true,
    access: [
      { sid: userSid, type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-18', type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
      { sid: 'S-1-5-32-544', type: 'allow', mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true },
    ],
    ...overrides,
  }
}

function fixture(existing?: { readonly contents: Buffer; readonly evidence: WindowsHostPrivatePathEvidence }) {
  const written: Buffer[] = []
  const ensurePrivateDirectory = vi.fn<WindowsHostRegistrationFileBindings['ensurePrivateDirectory']>(
    () => evidence('directory'),
  )
  const readPrivateFile = vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>(() => existing)
  const replacePrivateFile = vi.fn<WindowsHostRegistrationFileBindings['replacePrivateFile']>(
    (_path, contents) => {
      written.push(contents)
      return evidence('file')
    },
  )
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory,
    readPrivateFile,
    replacePrivateFile,
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  }
  return {
    bindings,
    ensurePrivateDirectory,
    readPrivateFile,
    replacePrivateFile,
    written,
    publisher: new WindowsHostRegistrationPublisher({ root, userSid, bindings }),
  }
}

describe('Windows Host registration authority', () => {
  it('rejects malformed roots and owner SIDs and exposes a stable lease conflict error', () => {
    for (const malformed of [String.raw`relative\root`, String.raw`C:\root\..\host`, 'C:\\root\u0000']) {
      expect(() => new WindowsHostRegistrationPublisher({ root: malformed, userSid, bindings: fixture().bindings }))
        .toThrow(HostAuthorityError)
    }
    expect(() => windowsHostPrivateSecurityDescriptor('S-1-5-18')).toThrow(HostAuthorityError)
    expect(new WindowsHostPrivateLeaseConflictError()).toMatchObject({
      name: 'WindowsHostPrivateLeaseConflictError',
      message: 'Windows Host private file lease is already held',
    })
  })

  it('creates an owner-scoped root and publishes one exact atomic registration', () => {
    const state = fixture()
    state.publisher.publish(registration)

    expect(state.ensurePrivateDirectory).toHaveBeenCalledWith(root, expect.stringContaining(userSid))
    expect(state.ensurePrivateDirectory.mock.calls[0]?.[1]).toContain('(A;OICI;FA;;;')
    expect(state.readPrivateFile).toHaveBeenCalledWith(registrationPath, 16 * 1024)
    expect(state.replacePrivateFile).toHaveBeenCalledWith(
      registrationPath,
      Buffer.from(`${JSON.stringify(registration)}\n`),
      expect.stringContaining(userSid),
    )
    const written = state.written[0]
    expect(written).toBeDefined()
    expect(JSON.parse(written?.toString('utf8') ?? '')).toEqual(registration)
  })

  it('permits only the executable digest to change for the same installation record', () => {
    const existing = { ...registration, executable_signature_digest: '2'.repeat(64) }
    const state = fixture({ contents: Buffer.from(`${JSON.stringify(existing)}\n`), evidence: evidence('file') })
    expect(() => { state.publisher.publish(registration) }).not.toThrow()
    expect(state.replacePrivateFile).toHaveBeenCalledOnce()
  })

  it('refuses to overwrite another installation or malformed existing record', () => {
    for (const value of [
      { ...registration, installation_id: 'slark-dsh-other' },
      { ...registration, unexpected: true },
      { ...registration, executable_signature_digest: 'not-a-digest' },
    ]) {
      const state = fixture({ contents: Buffer.from(JSON.stringify(value)), evidence: evidence('file') })
      expect(() => { state.publisher.publish(registration) }).toThrow()
      expect(state.replacePrivateFile).not.toHaveBeenCalled()
    }
  })

  it('fails closed on a junction, hard link, wrong owner, inherited DACL, or broad ACE', () => {
    const unsafe: WindowsHostPrivatePathEvidence[] = [
      evidence('directory', { reparsePoint: true }),
      evidence('file', { linkCount: 2 }),
      evidence('file', { ownerSid: 'S-1-5-21-9-9-9-1001' }),
      evidence('file', { daclProtected: false }),
      evidence('file', { access: [
        ...evidence('file').access,
        { sid: 'S-1-1-0', type: 'allow', mask: 0x2, inherited: false, objectInherit: true, containerInherit: true },
      ] }),
    ]
    for (const unsafeEvidence of unsafe) {
      const state = fixture({ contents: Buffer.from(`${JSON.stringify(registration)}\n`), evidence: unsafeEvidence })
      if (unsafeEvidence.kind === 'directory') {
        state.ensurePrivateDirectory.mockReturnValueOnce(unsafeEvidence)
      }
      expect(() => { state.publisher.publish(registration) }).toThrow()
      expect(state.replacePrivateFile).not.toHaveBeenCalled()
    }
  })

  it('rejects every malformed private-path security fact', () => {
    const malformed: WindowsHostPrivatePathEvidence[] = [
      evidence('file', { access: evidence('file').access.slice(0, 2) }),
      evidence('file', { access: evidence('file').access.map((entry, index) => index === 0 ? { ...entry, type: 'deny' } : entry) }),
      evidence('file', { access: evidence('file').access.map((entry, index) => index === 0 ? { ...entry, mask: 1 } : entry) }),
      evidence('file', { access: evidence('file').access.map((entry, index) => index === 0 ? { ...entry, inherited: true } : entry) }),
      evidence('file', { access: evidence('file').access.map((entry, index) => index === 0 ? { ...entry, objectInherit: false } : entry) }),
      evidence('file', { access: evidence('file').access.map((entry, index) => index === 0 ? { ...entry, containerInherit: false } : entry) }),
      evidence('file', { access: [evidence('file').access[0]!, evidence('file').access[0]!, evidence('file').access[2]!] }),
    ]
    for (const item of malformed) {
      expect(() => { assertWindowsHostPrivatePathEvidence(item, 'file', userSid) }).toThrow(HostAuthorityError)
    }
  })

  it('rejects invalid new records, invalid JSON, and oversized serialization', () => {
    const invalidRecords = [
      null,
      [],
      { ...registration, schema_version: 2 },
      { ...registration, endpoint_registration_id: 7 },
      { ...registration, socket_path: 7 },
      { ...registration, installation_id: 7 },
      { ...registration, installation_public_key: 7 },
      { ...registration, installation_public_key: 'short' },
      { ...registration, executable_signature_digest: 7 },
    ]
    for (const invalid of invalidRecords) {
      const state = fixture()
      expect(() => { state.publisher.publish(invalid as never) }).toThrow(HostAuthorityError)
      expect(state.ensurePrivateDirectory).not.toHaveBeenCalled()
    }

    const malformedExisting = fixture({ contents: Buffer.from('{'), evidence: evidence('file') })
    expect(() => { malformedExisting.publisher.publish(registration) }).toThrow(HostAuthorityError)

    const oversized = { ...registration, socket_path: 'x'.repeat(16 * 1024) }
    expect(() => { fixture().publisher.publish(oversized) }).toThrow(HostAuthorityError)
  })

  it('validates the replacement result instead of trusting a successful rename', () => {
    const state = fixture()
    state.replacePrivateFile.mockReturnValueOnce(evidence('file', { reparsePoint: true }))
    expect(() => { state.publisher.publish(registration) }).toThrow()
  })
})
