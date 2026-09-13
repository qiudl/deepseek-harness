import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { prepareWindowsDesktopHostEmbeddingIdentity } from '../src/windows-embedding-identity.ts'
import type {
  WindowsHostPrivatePathEvidence,
  WindowsHostRegistrationFileBindings,
} from '../src/windows-host-registration.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\environments\production`
const userSid = 'S-1-5-21-1000-2000-3000-1001'

function fixture() {
  const files = new Map<string, Buffer>()
  const evidence = (kind: 'directory' | 'file'): WindowsHostPrivatePathEvidence => ({
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
  })
  const createPrivateFile = vi.fn<NonNullable<
    WindowsHostRegistrationFileBindings['createPrivateFile']
  >>((path, contents) => {
    if (files.has(path)) return { state: 'exists', evidence: evidence('file') }
    files.set(path, Buffer.from(contents))
    return { state: 'created', evidence: evidence('file') }
  })
  const readPrivateFile = vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>((path) => {
    const contents = files.get(path)
    return contents === undefined ? undefined : { contents: Buffer.from(contents), evidence: evidence('file') }
  })
  const replacePrivateFile = vi.fn<WindowsHostRegistrationFileBindings['replacePrivateFile']>((path, contents) => {
    files.set(path, Buffer.from(contents))
    return evidence('file')
  })
  const bindings: WindowsHostRegistrationFileBindings = {
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    createPrivateFile,
    readPrivateFile,
    replacePrivateFile,
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  }
  const accountAccessKeyring = '{"keys":[],"version":2}'
  const input = {
    platform: 'win32',
    arch: 'x64',
    root,
    accountAccessKeyring,
    accountKeyringSha256: createHash('sha256').update(accountAccessKeyring).digest('hex'),
    runtimeGeneration: 1,
    schemaGeneration: 1,
  }
  const dependencies = {
    loadCurrentUserSid: vi.fn(async () => () => userSid),
    loadRegistrationFileBindings: vi.fn(async () => bindings),
    randomBytes: vi.fn(() => Buffer.alloc(32, 7)),
    randomUUID: vi.fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222'),
    generateKeyPair: vi.fn(() => generateKeyPairSync('ed25519')),
  }
  return { files, bindings, input, dependencies, evidence }
}

describe('Windows embedding identity', () => {
  it('creates a complete SID-private identity and preserves it on retry', async () => {
    const state = fixture()
    const first = await prepareWindowsDesktopHostEmbeddingIdentity(state.input, state.dependencies)
    const second = await prepareWindowsDesktopHostEmbeddingIdentity(state.input, state.dependencies)

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      deviceIndexKeyPath: `${root}\\identity\\device-index-key.v1`,
      accountKeyringPath: `${root}\\identity\\account-access-keyring.v2.json`,
      installationPrivateKeyPath: `${root}\\identity\\installation-private-key.pem`,
      installationId: '11111111-1111-4111-8111-111111111111',
      endpointRegistrationId: '22222222-2222-4222-8222-222222222222',
    })
    expect(state.dependencies.generateKeyPair).toHaveBeenCalledOnce()
    expect(state.dependencies.randomUUID).toHaveBeenCalledTimes(2)
    expect(state.files.size).toBe(4)
  })

  it('recovers a create race by reading the winning stable private file', async () => {
    const state = fixture()
    const winner = generateKeyPairSync('ed25519')
    const privatePath = `${root}\\identity\\installation-private-key.pem`
    state.bindings.createPrivateFile = vi.fn<NonNullable<
      WindowsHostRegistrationFileBindings['createPrivateFile']
    >>((path, contents) => {
      if (path === privatePath && !state.files.has(path)) {
        state.files.set(path, Buffer.from(winner.privateKey.export({ format: 'pem', type: 'pkcs8' })))
      }
      if (state.files.has(path)) return { state: 'exists', evidence: state.evidence('file') }
      state.files.set(path, Buffer.from(contents))
      return { state: 'created', evidence: state.evidence('file') }
    })

    const identity = await prepareWindowsDesktopHostEmbeddingIdentity(state.input, state.dependencies)
    expect(identity.installationPublicKey).toBe(
      winner.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'),
    )
  })

  it('fails closed when an existing identity belongs to another generation', async () => {
    const state = fixture()
    await prepareWindowsDesktopHostEmbeddingIdentity(state.input, state.dependencies)
    await expect(prepareWindowsDesktopHostEmbeddingIdentity({
      ...state.input,
      runtimeGeneration: 2,
    }, state.dependencies)).rejects.toMatchObject({ code: 'conflict' })
  })
})
