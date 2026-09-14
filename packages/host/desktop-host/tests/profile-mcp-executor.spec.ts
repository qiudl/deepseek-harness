import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import { ProfileMcpExecutor } from '../src/profile-mcp-executor.ts'
import { PosixMcpStorage } from '../src/profile-mcp-storage.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'host-mcp-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const profileId = randomUUID()
  const home = join(root, profileId)
  const web = join(home, 'profiles', 'web')
  mkdirSync(web, { recursive: true, mode: 0o700 })
  const patch = join(web, 'cordis.patch.yml')
  const original = '# keep user comment\n- insert:\n    - id: unrelated\n      name: local-plugin\n'
  writeFileSync(patch, original, { mode: 0o600 })
  writeFileSync(join(home, 'cordis.patch.yml'), 'host-owned', { mode: 0o600 })
  const receipts = new FileExtensionReceipts(join(root, 'receipts'), process.getuid!())
  const target = (id: string) => { if (id !== profileId) throw Error('unauthorized'); return home }
  return { root, profileId, home, web, patch, original, receipts, target }
}
const payload = JSON.stringify({ mcpServers: { demo: { url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: '${MCP_TEST_KEY}' } } } })

it('rejects invalid recovery identities before creating or reading a backup', () => {
  const f = fixture()
  const storage = new PosixMcpStorage({ profileRoot: f.target, uid: process.getuid!() })
  for (const id of ['../outside', '', 'not-a-uuid']) {
    expect(() => { storage.backup(f.profileId, id, f.original) }).toThrow('invalid_input')
    expect(() => { storage.readBackup(f.profileId, id) }).toThrow('invalid_input')
  }
  expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
})
it('preserves a concurrently changed patch instead of deleting it during restoration', () => {
  const f = fixture()
  const storage = new PosixMcpStorage({ profileRoot: f.target, uid: process.getuid!() })
  expect(() => { storage.publish(f.profileId, null, 'older patch', () => {}) }).toThrow('revision_conflict')
  expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
})
it('accepts an already absent patch when restoring original absence', () => {
  const f = fixture()
  const storage = new PosixMcpStorage({ profileRoot: f.target, uid: process.getuid!() })
  unlinkSync(f.patch)
  storage.publish(f.profileId, null, null, () => {})
  expect(storage.snapshot(f.profileId)).toBeNull()
})

describe('Host Profile MCP execution', () => {
  it('merges using Hub semantics into only the resolved Profile and waits for reload acknowledgement', async () => {
    const f = fixture(); let loaded = ''
    const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async (id) => {
      expect(id).toBe(f.profileId)
      loaded = readFileSync(f.patch, 'utf8')
      expect(f.receipts.list(id).at(-1)?.state).toBe('running')
    } })
    const engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
    const plan = await engine.prepare(() => f.profileId, 'mcp', payload)
    expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
    const id = randomUUID(); engine.commit(() => f.profileId, plan.planId, id)
    await engine.settled()
    expect(engine.status(() => f.profileId, id).state).toBe('succeeded')
    expect(loaded).toContain('!!js process.env.MCP_TEST_KEY')
    expect(loaded).toContain('id: mcp-demo')
    expect(loaded).toContain('keep user comment')
    expect(loaded).toContain('name: local-plugin')
    expect(readFileSync(join(f.home, 'cordis.patch.yml'), 'utf8')).toBe('host-owned')
    expect(await executor.inventory(f.profileId)).toEqual([{ id: 'mcp-demo', name: 'demo', transport: 'streamable-http' }])
    await engine.dispose()
  })

  it('rejects malformed or partially skipped imports before confirmation', async () => {
    const f = fixture()
    const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async () => {} })
    const engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
    for (const bad of ['{}', '{', JSON.stringify({ mcpServers: { 'invalid name': { command: 'anything' } } })]) {
      await expect(engine.prepare(() => f.profileId, 'mcp', bad)).rejects.toThrow()
    }
    await expect(engine.prepare(() => f.profileId, 'plugin', 'some-package')).rejects.toThrow()
    expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
    expect(f.receipts.list(f.profileId)).toEqual([])
    await engine.dispose()
  })

  it('rejects symlink Profile directories and records a reload failure as unknown', async () => {
    const f = fixture()
    const alias = join(f.root, 'alias'); symlinkSync(f.home, alias)
    const unsafe = new ProfileMcpExecutor({ profileRoot: () => alias, uid: process.getuid!(), reload: async () => {} })
    await expect(unsafe.revision(f.profileId)).rejects.toThrow()
    const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async () => { throw Error('reload failed') } })
    const engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
    const plan = await engine.prepare(() => f.profileId, 'mcp', payload); const id = randomUUID()
    engine.commit(() => f.profileId, plan.planId, id); await engine.settled()
    expect(engine.status(() => f.profileId, id).state).toBe('unknown')
    expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
    await engine.dispose()
  })
  it('restores the prior patch and reloads it when the new MCP cannot start', async () => {
    const f = fixture(); let reloads = 0
    const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async () => {
      if (++reloads === 1) throw Error('MCP unavailable')
      expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
    } })
    const engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
    const plan = await engine.prepare(() => f.profileId, 'mcp', payload); const id = randomUUID()
    engine.commit(() => f.profileId, plan.planId, id); await engine.settled()
    expect(engine.status(() => f.profileId, id).state).toBe('failed')
    expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
    expect(reloads).toBe(2)
    await engine.dispose()
  })

})

it('rejects removal of unrelated rows, missing IDs and extra input without changing the patch', async () => {
  const f = fixture()
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async () => {} })
  for (const input of [{ action: 'remove', id: 'unrelated' }, { action: 'remove', id: 'mcp-missing' },
    { action: 'remove', id: '../cordis.patch.yml' }, { action: 'remove', id: 'mcp-demo', path: f.patch }]) {
    expect(() => { executor.validate(f.profileId, 'mcp', JSON.stringify(input)) }).toThrow()
  }
  expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
})

it('preserves other rows on removal and restores the exact patch if runtime removal fails', async () => {
  const f = fixture(); let rejectRemoval = false
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(),
    reload: async (_id, _signal, entries, _guard, removed) => {
      if (removed.length) {
        expect(removed).toEqual(['mcp-demo']); expect(entries).toEqual([])
        expect(readFileSync(f.patch, 'utf8')).toContain('name: local-plugin')
        expect(readFileSync(f.patch, 'utf8')).not.toContain('id: mcp-demo')
        if (rejectRemoval) throw Error('still visible')
      }
    } })
  const context = { kind: 'mcp' as const, signal: new AbortController().signal, guard() {} }
  await executor.execute(f.profileId, payload, context)
  const installed = readFileSync(f.patch, 'utf8'); const removal = JSON.stringify({ action: 'remove', id: 'mcp-demo' })
  rejectRemoval = true
  expect(await executor.execute(f.profileId, removal, context)).toEqual({ state: 'failed' })
  expect(readFileSync(f.patch, 'utf8')).toBe(installed)
  rejectRemoval = false
  expect(await executor.execute(f.profileId, removal, context)).toEqual({ state: 'succeeded' })
  expect(await executor.inventory(f.profileId)).toEqual([])
  expect(readFileSync(f.patch, 'utf8')).toContain('keep user comment')
})

it('refuses renamed, missing and extra-field edits and restores a failed update', async () => {
  const f = fixture(); let fail = false
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async () => {
    if (fail) { fail = false; throw Error('new endpoint unavailable') }
  } })
  const context = { kind: 'mcp' as const, signal: new AbortController().signal, guard() {} }
  await executor.execute(f.profileId, payload, context)
  const installed = readFileSync(f.patch, 'utf8')
  const edit = { action: 'update', id: 'mcp-demo', mcpServers: { demo: { command: 'node', args: ['new.js'] } } }
  for (const input of [{ ...edit, id: 'mcp-other' }, { ...edit, mcpServers: { missing: { command: 'node' } }, id: 'mcp-missing' },
    { ...edit, path: '/tmp/other' }, { ...edit, mcpServers: { demo: { type: 'sse', url: 'https://example.test' } } }]) {
    expect(() => { executor.validate(f.profileId, 'mcp', JSON.stringify(input)) }).toThrow()
  }
  expect(readFileSync(f.patch, 'utf8')).toBe(installed)
  fail = true
  expect(await executor.execute(f.profileId, JSON.stringify(edit), context)).toEqual({ state: 'failed' })
  expect(readFileSync(f.patch, 'utf8')).toBe(installed)
})


it('requires newly introduced MCP rows to disappear before reporting a verified rollback', async () => {
  const f = fixture(); let calls = 0; let rollbackRemoved: readonly string[] = []
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(),
    reload: async (_id, _signal, entries, _guard, removed) => {
      if (++calls === 1) throw Error('discovery failed after activation')
      rollbackRemoved = removed
      expect(entries).toEqual([])
      expect(removed).toEqual(['mcp-demo'])
      throw Error('new MCP is still active')
    } })
  const engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
  const plan = await engine.prepare(() => f.profileId, 'mcp', payload); const id = randomUUID()
  engine.commit(() => f.profileId, plan.planId, id); await engine.settled()
  expect(calls).toBe(2)
  expect(rollbackRemoved).toEqual(['mcp-demo'])
  expect(engine.status(() => f.profileId, id).state).toBe('unknown')
  expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
  await engine.dispose()
})

it('restores an absent patch as absent when activation fails', async () => {
  const f = fixture(); unlinkSync(f.patch); let calls = 0
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(),
    reload: async (_id, _signal, entries, _guard, removed) => {
      if (++calls === 1) throw Error('activation failed')
      expect(existsSync(f.patch)).toBe(false)
      expect(entries).toEqual([])
      expect(removed).toEqual(['mcp-demo'])
    } })
  const context = { kind: 'mcp' as const, signal: new AbortController().signal, guard() {} }
  expect(await executor.execute(f.profileId, payload, context)).toEqual({ state: 'failed' })
  expect(existsSync(f.patch)).toBe(false)
})

it('distinguishes an absent patch from an empty patch in prepared revisions', async () => {
  const f = fixture(); unlinkSync(f.patch)
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async () => {} })
  const absent = await executor.revision(f.profileId)
  writeFileSync(f.patch, '', { mode: 0o600 })
  expect(await executor.revision(f.profileId)).not.toBe(absent)
})


it('does not remove an original MCP ID during failed same-name update compensation', async () => {
  const f = fixture(); let calls = 0
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(),
    reload: async (_id, _signal, entries, _guard, removed) => {
      if (++calls === 2) throw Error('updated endpoint failed')
      if (calls === 3) {
        expect(entries).toEqual(['mcp-demo'])
        expect(removed).toEqual([])
      }
    } })
  const context = { kind: 'mcp' as const, signal: new AbortController().signal, guard() {} }
  await executor.execute(f.profileId, payload, context)
  const original = readFileSync(f.patch, 'utf8')
  expect(await executor.execute(f.profileId, JSON.stringify({ action: 'update', id: 'mcp-demo',
    mcpServers: { demo: { command: 'node', args: ['unavailable.js'] } } }), context)).toEqual({ state: 'failed' })
  expect(calls).toBe(3)
  expect(readFileSync(f.patch, 'utf8')).toBe(original)
})

it('keeps a concurrent patch edit when activation fails', async () => {
  const f = fixture(); let calls = 0
  const concurrent = '# concurrent user edit\n[]\n'
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async () => {
    ++calls
    writeFileSync(f.patch, concurrent)
    throw Error('activation failed')
  } })
  const context = { kind: 'mcp' as const, signal: new AbortController().signal, guard() {} }
  await expect(executor.execute(f.profileId, payload, context)).rejects.toThrow('revision_conflict')
  expect(calls).toBe(1)
  expect(readFileSync(f.patch, 'utf8')).toBe(concurrent)
})


it('recovers an interrupted MCP publication through a new confirmed receipt and preserves historical outcomes', async () => {
  const f = fixture(); let acknowledge = false; let calls = 0
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(),
    reload: async (_id, _signal, entries, _guard, removed) => {
      ++calls
      expect(entries).toEqual([]); expect(removed).toEqual(['mcp-demo'])
      if (!acknowledge) throw Error('runtime not yet confirmed')
    } })
  const execute = executor.execute.bind(executor)
  executor.execute = (profileId, input, context) => execute(profileId, input, { ...context,
    checkpointMcp: (evidence) => {
      context.checkpointMcp?.(evidence)
      if (evidence.stage === 'published') throw Error('interrupted after publication')
    } })
  let engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
  const plan = await engine.prepare(() => f.profileId, 'mcp', payload); const id = randomUUID()
  engine.commit(() => f.profileId, plan.planId, id); await engine.settled()
  expect(calls).toBe(0)
  expect(engine.status(() => f.profileId, id)).toMatchObject({ state: 'unknown', canRestore: true, mcpRecovery: { stage: 'published' } })
  const published = readFileSync(f.patch, 'utf8')
  await engine.dispose()
  engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
  const restore = JSON.stringify({ action: 'restore-config', operationId: id })
  await expect(engine.prepare(() => randomUUID(), 'mcp', restore)).rejects.toThrow('unauthorized')
  writeFileSync(f.patch, '# concurrent\n[]\n')
  await expect(engine.prepare(() => f.profileId, 'mcp', restore)).rejects.toThrow('revision_conflict')
  writeFileSync(f.patch, published)
  const first = await engine.prepare(() => f.profileId, 'mcp', restore); const firstId = randomUUID()
  engine.commit(() => f.profileId, first.planId, firstId); await engine.settled()
  expect(readFileSync(f.patch, 'utf8')).toBe(f.original)
  expect(engine.status(() => f.profileId, firstId)).toMatchObject({ state: 'unknown', restores: id })
  acknowledge = true
  const retry = await engine.prepare(() => f.profileId, 'mcp', restore); const retryId = randomUUID()
  engine.commit(() => f.profileId, retry.planId, retryId); await engine.settled()
  expect(engine.status(() => f.profileId, retryId)).toMatchObject({ state: 'succeeded', restores: id })
  expect(engine.status(() => f.profileId, id)).toMatchObject({ state: 'unknown', restoredBy: retryId })
  expect(engine.status(() => f.profileId, firstId)).toMatchObject({ state: 'unknown', restoredBy: retryId })
  expect(engine.status(() => f.profileId, id).canRestore).toBeUndefined()
  expect(calls).toBe(2)
  await engine.dispose()
  engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
  expect(engine.status(() => f.profileId, id).restoredBy).toBe(retryId)
  const next = await engine.prepare(() => f.profileId, 'mcp', payload)
  expect(() => engine.commit(() => f.profileId, next.planId, randomUUID())).not.toThrow()
  await engine.dispose()
})


it.each(['missing', 'tampered', 'public', 'symlink', 'hardlink'])('refuses %s MCP backup without modifying the current patch', async (damage) => {
  const f = fixture()
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(), reload: async () => {} })
  const execute = executor.execute.bind(executor)
  executor.execute = (profileId, input, context) => execute(profileId, input, { ...context, checkpointMcp: (evidence) => {
    context.checkpointMcp?.(evidence)
    if (evidence.stage === 'published') throw Error('interrupted')
  } })
  const engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
  const plan = await engine.prepare(() => f.profileId, 'mcp', payload); const id = randomUUID()
  engine.commit(() => f.profileId, plan.planId, id); await engine.settled()
  const published = readFileSync(f.patch, 'utf8'); const backup = join(f.web, `.mcp-before-${id}`)
  if (damage === 'missing') unlinkSync(backup)
  if (damage === 'tampered') writeFileSync(backup, '1[]')
  if (damage === 'public') chmodSync(backup, 0o644)
  if (damage === 'symlink') { unlinkSync(backup); symlinkSync(f.patch, backup) }
  if (damage === 'hardlink') linkSync(backup, join(f.web, 'backup-alias'))
  await expect(engine.prepare(() => f.profileId, 'mcp', JSON.stringify({ action: 'restore-config', operationId: id }))).rejects.toThrow()
  expect(readFileSync(f.patch, 'utf8')).toBe(published)
  expect(engine.status(() => f.profileId, id).state).toBe('unknown')
  await engine.dispose()
})

it('keeps the original absent patch recoverable after interruption before publication', async () => {
  const f = fixture(); unlinkSync(f.patch); let calls = 0
  const executor = new ProfileMcpExecutor({ profileRoot: f.target, uid: process.getuid!(),
    reload: async (_id, _signal, entries, _guard, removed) => {
      calls++; expect(existsSync(f.patch)).toBe(false); expect(entries).toEqual([]); expect(removed).toEqual(['mcp-demo'])
    } })
  const execute = executor.execute.bind(executor)
  executor.execute = (profileId, input, context) => execute(profileId, input, { ...context, checkpointMcp: (evidence) => {
    context.checkpointMcp?.(evidence)
    throw Error('checkpoint stored; no file publication yet')
  } })
  const engine = new ProfileExtensionOperations(f.receipts, executor, { now: () => 1000 })
  const plan = await engine.prepare(() => f.profileId, 'mcp', payload); const id = randomUUID()
  engine.commit(() => f.profileId, plan.planId, id); await engine.settled()
  expect(existsSync(f.patch)).toBe(false)
  expect(engine.status(() => f.profileId, id)).toMatchObject({ state: 'unknown', mcpRecovery: { stage: 'prepared', originalPresent: false } })
  const restored = await engine.prepare(() => f.profileId, 'mcp', JSON.stringify({ action: 'restore-config', operationId: id }))
  const recoveryId = randomUUID(); engine.commit(() => f.profileId, restored.planId, recoveryId); await engine.settled()
  expect(engine.status(() => f.profileId, recoveryId)).toMatchObject({ state: 'succeeded', restores: id })
  expect(existsSync(f.patch)).toBe(false); expect(calls).toBe(1)
  await engine.dispose()
})
