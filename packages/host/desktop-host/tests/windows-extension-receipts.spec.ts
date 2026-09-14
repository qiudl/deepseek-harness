import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ProfileExtensionOperations, type ExtensionReceipt } from '../src/extension-operations.ts'
import { WindowsExtensionReceipts } from '../src/windows-extension-receipts.ts'
import type { WindowsHostPrivatePathEvidence, WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\DSH\control`
const userSid = 'S-1-5-21-1000-2000-3000-1001'
function evidence(kind: 'directory' | 'file'): WindowsHostPrivatePathEvidence {
  return { kind, reparsePoint: false, linkCount: 1, ownerSid: userSid, daclProtected: true,
    access: [userSid, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({
      sid, type: 'allow' as const, mask: 0x1F01FF, inherited: false, objectInherit: true, containerInherit: true,
    })) }
}
function receipt(): ExtensionReceipt {
  return { version: 1, operationId: randomUUID(), profileId: randomUUID(), planId: randomUUID(), kind: 'mcp',
    digest: 'a'.repeat(64), state: 'running', cancellationRequested: false, createdAt: 1, updatedAt: 1 }
}
function fixture(initial?: Buffer, maximumBytes = 131072) {
  let contents = initial
  const bindings = {
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>(() => contents === undefined ? undefined : { contents: Buffer.from(contents), evidence: evidence('file') }),
    replacePrivateFile: vi.fn((_path: string, next: Buffer) => { contents = Buffer.from(next); return evidence('file') }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  } satisfies WindowsHostRegistrationFileBindings
  const options = { root, userSid, maximumBytes, bindings }
  return { bindings, options, store: () => new WindowsExtensionReceipts(options), bytes: () => contents }
}

it('retains independent Profile receipts across store recreation and atomic replacement', () => {
  const f = fixture(); const a = receipt(); const b = receipt(); const store = f.store()
  expect(store.read(a.operationId)).toBeUndefined()
  store.write(a); store.write(b); store.write({ ...a, state: 'succeeded', updatedAt: 2 })
  const reopened = f.store()
  expect(reopened.read(a.operationId)?.state).toBe('succeeded')
  expect(reopened.list(b.profileId)).toEqual([b])
  expect(reopened.list(randomUUID())).toEqual([])
  expect(f.bindings.replacePrivateFile).toHaveBeenLastCalledWith(
    `${root}\\extensions.v1.json`, expect.any(Buffer), expect.stringContaining(userSid),
  )
})

it('recovers an interrupted operation through the shared owner without executing it again', async () => {
  const f = fixture(); const old = receipt(); f.store().write(old)
  const execute = vi.fn(async () => ({ state: 'succeeded' as const }))
  const owner = new ProfileExtensionOperations(f.store(), { revision: async () => 'revision', execute }, { now: () => 10 })
  try {
    expect(owner.status(() => old.profileId, old.operationId)).toMatchObject({ state: 'unknown', reason: 'interrupted' })
    const plan = await owner.prepare(() => old.profileId, 'mcp', '{}')
    expect(() => owner.commit(() => old.profileId, plan.planId, randomUUID())).toThrow('busy')
    expect(execute).not.toHaveBeenCalled()
    expect(f.store().read(old.operationId)?.state).toBe('unknown')
  } finally { await owner.dispose() }
})

it('rejects unsafe directory and file evidence before replacing any receipt', () => {
  for (const changed of [{ reparsePoint: true }, { ownerSid: 'S-1-5-21-999' }, { linkCount: 2 }, { daclProtected: false }]) {
    const row = receipt(); const f = fixture(); f.store().write(row)
    const before = f.bytes()
    vi.mocked(f.bindings.readPrivateFile).mockReturnValue({ contents: before!, evidence: { ...evidence('file'), ...changed } })
    expect(() => { f.store().write(row) }).toThrow()
    expect(f.bytes()).toEqual(before)
    expect(f.bindings.replacePrivateFile).toHaveBeenCalledTimes(1)
  }
  const f = fixture()
  vi.mocked(f.bindings.ensurePrivateDirectory).mockReturnValue({ ...evidence('directory'), reparsePoint: true })
  expect(() => f.store()).toThrow()
  expect(f.bindings.replacePrivateFile).not.toHaveBeenCalled()
})

it('rejects corrupt, duplicate and oversized durable data without treating it as empty', () => {
  const a = receipt()
  for (const source of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{}'),
    Buffer.from(JSON.stringify({ version: 2, receipts: [] })),
    Buffer.from(JSON.stringify({ version: 1, receipts: [a, a] })),
    Buffer.from(JSON.stringify({ version: 1, receipts: [{ ...a, payload: 'private' }] })), Buffer.alloc(131073)]) {
    const f = fixture(source)
    expect(() => { f.store().write(a) }).toThrow()
    expect(f.bytes()).toEqual(source)
    expect(f.bindings.replacePrivateFile).not.toHaveBeenCalled()
  }
})

it('enforces exact total byte capacity and refuses unsafe identifiers and paths', () => {
  const a = receipt(); const bytes = Buffer.byteLength(JSON.stringify({ version: 1, receipts: [a] }))
  const exact = fixture(undefined, bytes); exact.store().write(a)
  const small = fixture(undefined, bytes - 1)
  expect(() => { small.store().write(a) }).toThrow()
  expect(small.bindings.replacePrivateFile).not.toHaveBeenCalled()
  expect(() => exact.store().read('../other')).toThrow()
  expect(() => exact.store().list('../other')).toThrow()
  for (const badRoot of ['relative', `${root}\\..\\other`, `${root}:stream`, '//server/share']) {
    expect(() => new WindowsExtensionReceipts({ ...exact.options, root: badRoot })).toThrow()
  }
})

it('preserves existing receipts when native publication fails', () => {
  const f = fixture(); const a = receipt(); f.store().write(a); const before = f.bytes()
  vi.mocked(f.bindings.replacePrivateFile).mockImplementation(() => { throw Error('publication_failed') })
  expect(() => { f.store().write({ ...a, state: 'succeeded' }) }).toThrow('publication_failed')
  expect(f.bytes()).toEqual(before)
})
