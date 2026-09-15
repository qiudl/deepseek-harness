import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ProfileExtensionOperations } from '../src/extension-operations.ts'
import { WindowsExtensionReceipts } from '../src/windows-extension-receipts.ts'
import { ProfileMcpExecutor } from '../src/profile-mcp-executor.ts'
import { WindowsMcpStorage } from '../src/windows-mcp-storage.ts'
import type { WindowsHostPrivatePathEvidence, WindowsHostRegistrationFileBindings } from '../src/windows-host-registration.ts'

const root = String.raw`C:\Users\alice\AppData\Local\Slark\profiles\person`
const patch = `${root}\\profiles\\web\\cordis.patch.yml`
const sid = 'S-1-5-21-1000-2000-3000-1001'
const payload = JSON.stringify({ mcpServers: { demo: { url: 'https://example.com/mcp' } } })
function evidence(kind: 'file' | 'directory'): WindowsHostPrivatePathEvidence {
  return { kind, reparsePoint: false, linkCount: 1, ownerSid: sid, daclProtected: true,
    access: [sid, 'S-1-5-18', 'S-1-5-32-544'].map(sid => ({ sid, type: 'allow', mask: 0x1F01FF,
      inherited: false, objectInherit: true, containerInherit: true })) }
}
function fixture(original: string | null) {
  const files = new Map<string, Buffer>()
  if (original !== null) files.set(patch, Buffer.from(original))
  const profileId = randomUUID()
  const bindings = {
    inspectExistingDirectory: vi.fn(() => evidence('directory')),
    ensurePrivateDirectory: vi.fn(() => evidence('directory')),
    readPrivateFile: vi.fn<WindowsHostRegistrationFileBindings['readPrivateFile']>((path, max) => {
      const contents = files.get(path)
      if (contents && contents.length > max) throw Error('oversize')
      return contents === undefined ? undefined : { contents, evidence: evidence('file') }
    }),
    createPrivateFile: vi.fn<NonNullable<WindowsHostRegistrationFileBindings['createPrivateFile']>>((path, contents) => {
      if (files.has(path)) return { state: 'exists', evidence: evidence('file') }
      files.set(path, Buffer.from(contents)); return { state: 'created', evidence: evidence('file') }
    }),
    replacePrivateFile: vi.fn((path: string, contents: Buffer) => { files.set(path, Buffer.from(contents)); return evidence('file') }),
    removePrivateFile: vi.fn((path: string, expected: Buffer, _sid: string, guard: () => void) => {
      if (!files.get(path)?.equals(expected)) throw Error('revision_conflict')
      guard(); files.delete(path)
    }),
    acquirePrivateFileLease: vi.fn(() => ({ evidence: evidence('file'), initialize: vi.fn(), release: vi.fn() })),
  } satisfies WindowsHostRegistrationFileBindings
  const storage = new WindowsMcpStorage({ profileRoot: (id) => { if (id !== profileId) throw Error('unauthorized'); return root },
    userSid: sid, bindings })
  return { files, bindings, storage, profileId }
}
it('reuses Hub conversion on Windows and acknowledges the actual Profile before success', async () => {
  const f = fixture('# keep\n[]\n')
  const reload = vi.fn(async () => { expect(f.files.get(patch)?.toString()).toContain('mcp-demo') })
  const executor = new ProfileMcpExecutor({ storage: f.storage, reload })
  const result = await executor.execute(f.profileId, payload, { kind: 'mcp', signal: new AbortController().signal, guard() {} })
  expect(result.state).toBe('succeeded')
  expect(reload).toHaveBeenCalledOnce()
  expect(await executor.inventory(f.profileId)).toEqual([{ id: 'mcp-demo', name: 'demo', transport: 'streamable-http' }])
  expect(f.files.get(patch)?.toString()).toContain('# keep')
})
it.each([null, ''])('restores exact original file presence on failed reload: %j', async (original) => {
  const f = fixture(original); let calls = 0
  const executor = new ProfileMcpExecutor({ storage: f.storage, reload: async () => { if (++calls === 1) throw Error('startup_failed') } })
  const result = await executor.execute(f.profileId, payload, { kind: 'mcp', signal: new AbortController().signal, guard() {} })
  expect(result.state).toBe('failed')
  expect(f.files.get(patch)?.toString() ?? null).toBe(original)
  expect(calls).toBe(2)
  expect(f.bindings.removePrivateFile).toHaveBeenCalledTimes(original === null ? 1 : 0)
})
it('retains exclusive operation backups and rejects stale revisions and lost authority', () => {
  const f = fixture('[]'); const operationId = randomUUID()
  f.storage.backup(f.profileId, operationId, null)
  expect(f.storage.readBackup(f.profileId, operationId)).toBe('0')
  expect(() => { f.storage.backup(f.profileId, operationId, '') }).toThrow()
  expect(() => { f.storage.publish(f.profileId, null, 'changed', () => {}) }).toThrow('revision_conflict')
  expect(() => { f.storage.publish(f.profileId, null, '[]', () => { throw Error('lease_lost') }) }).toThrow('lease_lost')
  expect(f.files.get(patch)?.toString()).toBe('[]')
  expect(f.bindings.removePrivateFile).not.toHaveBeenCalled()
  expect(() => f.storage.readBackup(f.profileId, '../other')).toThrow()
})
it('reopens Windows receipts and explicitly restores an unknown MCP operation without replaying installation', async () => {
  const f = fixture(null)
  const store = () => new WindowsExtensionReceipts({ root: `${root}\\control`, userSid: sid, maximumBytes: 131072, bindings: f.bindings })
  let failReload = true
  const reload = vi.fn(async () => { if (failReload) throw Error('worker_unavailable') })
  const executor = new ProfileMcpExecutor({ storage: f.storage, reload })
  const first = new ProfileExtensionOperations(store(), executor, { now: () => 10 })
  const operationId = randomUUID()
  try {
    const plan = await first.prepare(() => f.profileId, 'mcp', payload)
    first.commit(() => f.profileId, plan.planId, operationId); await first.settled()
    expect(first.status(() => f.profileId, operationId)).toMatchObject({ state: 'unknown', mcpRecovery: { originalPresent: false } })
  } finally { await first.dispose() }
  failReload = false
  const reopened = new ProfileExtensionOperations(store(), executor, { now: () => 20 })
  try {
    const before = reload.mock.calls.length
    expect(reopened.status(() => f.profileId, operationId).state).toBe('unknown')
    expect(reload).toHaveBeenCalledTimes(before)
    const plan = await reopened.prepare(() => f.profileId, 'mcp', JSON.stringify({ action: 'restore-config', operationId }))
    const recoveryId = randomUUID()
    reopened.commit(() => f.profileId, plan.planId, recoveryId); await reopened.settled()
    expect(reopened.status(() => f.profileId, recoveryId)).toMatchObject({ state: 'succeeded', restores: operationId })
    expect(reopened.status(() => f.profileId, operationId)).toMatchObject({ state: 'unknown', restoredBy: recoveryId })
    expect(store().read(recoveryId)).toMatchObject({ state: 'succeeded', restores: operationId })
    expect(f.files.has(patch)).toBe(false)
  } finally { await reopened.dispose() }
})
it('rejects unsafe paths, directory evidence, invalid UTF-8 and invalid YAML before publication', async () => {
  const f = fixture('[]')
  const executor = new ProfileMcpExecutor({ storage: f.storage, reload: async () => {} })
  f.bindings.inspectExistingDirectory.mockReturnValue({ ...evidence('directory'), reparsePoint: true })
  await expect(executor.revision(f.profileId)).rejects.toThrow()
  f.bindings.inspectExistingDirectory.mockReturnValue(evidence('directory'))
  for (const bytes of [Buffer.from([0xff]), Buffer.from('key: value'), Buffer.alloc(1048577)]) {
    f.files.set(patch, bytes)
    await expect(executor.revision(f.profileId)).rejects.toThrow()
  }
  expect(f.bindings.replacePrivateFile).not.toHaveBeenCalled()
  const unsafe = new WindowsMcpStorage({ profileRoot: () => `${root}\\..\\other`, userSid: sid, bindings: f.bindings })
  expect(() => unsafe.snapshot(f.profileId)).toThrow()
})

it('rejects incomplete bindings and every untrusted persistence representation', () => {
  const f = fixture('[]')
  for (const missing of ['inspectExistingDirectory', 'createPrivateFile', 'removePrivateFile'] as const) {
    const bindings = { ...f.bindings, [missing]: undefined }
    expect(() => new WindowsMcpStorage({ profileRoot: () => root, userSid: sid, bindings })).toThrow('upgrade_required')
  }

  for (const unsafeRoot of [
    String.raw`\\server\share`,
    'C:\\unsafe\u0000path',
    String.raw`C:\safe:alternate`,
    String.raw`C:\safe\..\other`,
  ]) {
    const storage = new WindowsMcpStorage({ profileRoot: () => unsafeRoot, userSid: sid, bindings: f.bindings })
    expect(() => storage.snapshot(f.profileId)).toThrow('unsafe_profile')
  }

  f.bindings.readPrivateFile.mockReturnValueOnce({
    contents: Buffer.alloc(1_048_577),
    evidence: evidence('file'),
  })
  expect(() => f.storage.snapshot(f.profileId)).toThrow('unsafe_patch')
  expect(() => { f.storage.backup(f.profileId, randomUUID(), 'x'.repeat(1_048_577)) }).toThrow('unsafe_backup')
  expect(() => f.storage.readBackup(f.profileId, randomUUID())).toThrow('unsafe_backup')
  const emptyBackup = randomUUID()
  f.storage.backup(f.profileId, emptyBackup, '')
  f.files.set(`${root}\\profiles\\web\\.mcp-before-${emptyBackup}`, Buffer.alloc(0))
  expect(() => f.storage.readBackup(f.profileId, emptyBackup)).toThrow('unsafe_backup')
  expect(() => { f.storage.publish(f.profileId, 'x'.repeat(1_048_577), '[]', () => {}) }).toThrow('unsafe_patch')
  f.files.delete(patch)
  expect(() => { f.storage.publish(f.profileId, null, null, () => {}) }).not.toThrow()
})
