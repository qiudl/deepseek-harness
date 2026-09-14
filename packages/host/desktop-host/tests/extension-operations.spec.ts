import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, linkSync, chmodSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
it.each(['action', 'stage'])('refuses persisted plugin recovery with an array-valued %s', (field) => {
  const f = setup()
  onTestFinished(() => f.operations.dispose())
  const id = randomUUID()
  const intent = { action: 'install' as const, packageName: 'fixture', spec: 'fixture@1.0.0',
    originalSpecDigest: hash('original'), scopeDigest: hash('scope'), removedIds: [], stage: 'prepared' as const }
  f.store.write({ version: 1, operationId: id, profileId: f.profileId, planId: randomUUID(), kind: 'plugin',
    digest: hash('payload'), state: 'running', cancellationRequested: false, createdAt: 1, updatedAt: 2, pluginPackage: intent })
  const file = join(f.root, 'receipts', `${id}.json`)
  const receipt = JSON.parse(readFileSync(file, 'utf8'))
  receipt.pluginPackage[field] = [receipt.pluginPackage[field]]
  const malformed = JSON.stringify(receipt)
  writeFileSync(file, malformed)
  expect(() => f.store.read(id)).toThrow('invalid_receipt')
  expect(readFileSync(file, 'utf8')).toBe(malformed)
  expect(f.executions()).toBe(0)
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-extension-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const store = new FileExtensionReceipts(join(root, 'receipts'), process.getuid!())
  const profileId = randomUUID()
  const file = join(root, 'actual-config.json')
  writeFileSync(file, 'before', { mode: 0o600 })
  let allowed = true
  let revision = hash('before')
  let executions = 0
  const authority = () => { if (!allowed) throw Error('revoked'); return profileId }
  const executor = {
    revision: async (_profileId: string) => revision,
    execute: async (_profileId: string, _payload: string, context: { guard(): void; signal: AbortSignal }) => {
      context.guard(); executions += 1
      // Real filesystem effect, with receipt observable before the first write.
      expect(store.list(profileId).some(r => r.state === 'running')).toBe(true)
      writeFileSync(file, 'after')
      revision = hash('after')
      return { state: 'succeeded' as const }
    },
  }
  const operations = new ProfileExtensionOperations(store, executor, { now: () => 1000 })
  return { root, store, profileId, file, executor, operations, authority, executions: () => executions, revoke: () => { allowed = false }, change: () => { revision = hash('changed') } }
}

describe('Profile extension operations', () => {
  it('persists before real writes, returns an idempotent receipt and keeps payload secrets out of disk', async () => {
    const f = setup()
    const plan = await f.operations.prepare(f.authority, 'mcp', 'token=private-test')
    const id = randomUUID()
    const receipt = f.operations.commit(f.authority, plan.planId, id)
    expect(receipt.state).toBe('queued')
    expect(f.operations.commit(f.authority, plan.planId, id)).toEqual(receipt)
    await f.operations.settled()
    expect(f.operations.status(f.authority, id).state).toBe('succeeded')
    expect(readFileSync(f.file, 'utf8')).toBe('after')
    expect(f.executions()).toBe(1)
    const recovered = new ProfileExtensionOperations(f.store, f.executor, { now: () => 2000 })
    expect(recovered.status(f.authority, id).state).toBe('succeeded')
    expect(JSON.stringify(f.store.list(f.profileId))).not.toContain('private-test')
    await f.operations.dispose(); await recovered.dispose()
  })
  it('refuses another Profile, revoked authority and changed configuration before an effect', async () => {
    const f = setup()
    const plan = await f.operations.prepare(f.authority, 'plugin', 'package@1.0.0')
    expect(() => f.operations.commit(() => randomUUID(), plan.planId, randomUUID())).toThrow()
    f.change()
    const id = randomUUID(); f.operations.commit(f.authority, plan.planId, id)
    await f.operations.settled()
    expect(f.operations.status(f.authority, id).reason).toBe('revision_conflict')
    expect(f.executions()).toBe(0)
    expect(readFileSync(f.file, 'utf8')).toBe('before')
    f.revoke(); expect(() => f.operations.status(f.authority, id)).toThrow()
    await f.operations.dispose()
  })
  it('recovered unfinished receipts are unknown and cannot replay or overlap a new write', async () => {
    const f = setup(); const id = randomUUID()
    f.store.write({ version: 1, operationId: id, profileId: f.profileId, planId: randomUUID(), kind: 'skill', digest: hash('payload'), state: 'running', cancellationRequested: false, createdAt: 1, updatedAt: 2 })
    const recovered = new ProfileExtensionOperations(f.store, f.executor, { now: () => 3000 })
    expect(recovered.status(f.authority, id).state).toBe('unknown')
    const plan = await recovered.prepare(f.authority, 'skill', 'safe')
    expect(() => recovered.commit(f.authority, plan.planId, randomUUID())).toThrow(/busy/)
    expect(f.executions()).toBe(0)
    await recovered.dispose(); await f.operations.dispose()
  })
  it('waits for in-flight cancellation quiescence', async () => {
    const f = setup(); let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const running = new Promise<void>((resolve) => { started = resolve })
    const engine = new ProfileExtensionOperations(f.store, { ...f.executor, execute: async (_p, _v, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener('abort', () => { resolve() }, { once: true })
        started()
      })
      await gate
      return { state: 'cancelled' as const }
    } }, { now: () => 1000 })
    const plan = await engine.prepare(f.authority, 'plugin', 'one'); const id = randomUUID()
    engine.commit(f.authority, plan.planId, id); await running
    engine.cancel(f.authority, id)
    let disposed = false; const done = engine.dispose().then(() => { disposed = true })
    await Promise.resolve(); expect(disposed).toBe(false)
    release(); await done
    expect(f.store.read(id)?.state).toBe('cancelled')
    await f.operations.dispose()
  })
  it('rejects symlink receipts without modifying their target', () => {
    const f = setup(); const id = randomUUID()
    symlinkSync(f.file, join(f.root, 'receipts', `${id}.json`))
    expect(() => f.store.read(id)).toThrow()
    expect(readFileSync(f.file, 'utf8')).toBe('before')
  })
  it('rejects expired plans and duplicate confirmation under a different operation id', async () => {
    const f = setup(); let now = 1000
    const engine = new ProfileExtensionOperations(f.store, f.executor, { now: () => now })
    const old = await engine.prepare(f.authority, 'mcp', 'old')
    now += 300_001
    expect(() => engine.commit(f.authority, old.planId, randomUUID())).toThrow('expired')
    const plan = await engine.prepare(f.authority, 'mcp', 'new'); const id = randomUUID()
    engine.commit(f.authority, plan.planId, id)
    expect(() => engine.commit(f.authority, plan.planId, randomUUID())).toThrow('idempotency_conflict')
    expect(() => engine.commit(f.authority, randomUUID(), id)).toThrow('idempotency_conflict')
    await engine.dispose(); await f.operations.dispose()
  })

  it('cancels queued writes and rechecks authority after asynchronous revision reads', async () => {
    const f = setup()
    const plan = await f.operations.prepare(f.authority, 'skill', 'one'); const id = randomUUID()
    f.operations.commit(f.authority, plan.planId, id)
    expect(f.operations.cancel(f.authority, id).cancellationRequested).toBe(true)
    await f.operations.settled()
    expect(f.operations.status(f.authority, id).state).toBe('cancelled')
    expect(f.executions()).toBe(0)
    let read = 0
    const engine = new ProfileExtensionOperations(f.store, { ...f.executor, revision: async (p) => {
      if (++read === 2) f.revoke()
      return f.executor.revision(p)
    } }, { now: () => 1000 })
    const next = await engine.prepare(f.authority, 'mcp', 'two'); const nextId = randomUUID()
    engine.commit(f.authority, next.planId, nextId)
    await engine.settled()
    expect(f.store.read(nextId)?.reason).toBe('authority_revoked')
    expect(f.executions()).toBe(0)
    await engine.dispose(); await f.operations.dispose()
  })

  it('fences already-queued work when an earlier executor throws after writing', async () => {
    const f = setup(); let executions = 0
    const engine = new ProfileExtensionOperations(f.store, { ...f.executor, execute: async () => {
      executions++
      writeFileSync(f.file, 'partial')
      throw Error('token=never-persist-this')
    } }, { now: () => 1000 })
    const a = await engine.prepare(f.authority, 'mcp', 'a')
    const b = await engine.prepare(f.authority, 'skill', 'b')
    const first = randomUUID(); const second = randomUUID()
    engine.commit(f.authority, a.planId, first)
    engine.commit(f.authority, b.planId, second)
    await engine.settled()
    expect(engine.status(f.authority, first).state).toBe('unknown')
    expect(engine.status(f.authority, second)).toMatchObject({ state: 'failed', reason: 'interrupted' })
    expect(executions).toBe(1)
    expect(readFileSync(f.file, 'utf8')).toBe('partial')
    expect(JSON.stringify(f.store.list(f.profileId))).not.toContain('never-persist-this')
    await engine.dispose(); await f.operations.dispose()
  })

  it('composes with real Host leases and rejects owner, runtime and revocation mismatches', async () => {
    const f = setup()
    const registry = new ProfileRegistry({ root: join(f.root, 'registry'), deviceIndexKey: Buffer.alloc(32, 7), clock: { now: () => 1000 } })
    const host = new DesktopHost({ registry, clock: { now: () => 1000 }, runtimeGeneration: 5, ensureProfileWorker: async () => undefined })
    const local = await host.bootstrapLocalProfile({ keyHandle: 'keychain:test', unlockMaterial: Buffer.alloc(32, 9).toString('base64url'), ownerId: 'owner' })
    const opened = await host.openLocalProfile({ profileId: local.profileId, ownerId: 'owner' })
    const selector = { viewLeaseId: opened.viewLeaseId, leaseGeneration: opened.leaseGeneration, runtimeGeneration: 5, ownerId: 'owner' }
    const authority = () => host.authorizeExtensionView(selector)
    expect(authority()).toBe(local.profileId)
    expect(() => host.authorizeExtensionView({ ...selector, ownerId: 'other' })).toThrow()
    expect(() => host.authorizeExtensionView({ ...selector, runtimeGeneration: 4 })).toThrow()
    const engine = new ProfileExtensionOperations(f.store, { ...f.executor, execute: async (profileId, _payload, context) => {
      context.guard()
      expect(profileId).toBe(local.profileId)
      writeFileSync(f.file, 'host-authorized')
      return { state: 'succeeded' }
    } }, { now: () => 1000 })
    const plan = await engine.prepare(authority, 'mcp', 'one'); const id = randomUUID()
    engine.commit(authority, plan.planId, id); await engine.settled()
    expect(engine.status(authority, id).state).toBe('succeeded')
    expect(readFileSync(f.file, 'utf8')).toBe('host-authorized')
    const next = await engine.prepare(authority, 'skill', 'two'); const nextId = randomUUID()
    engine.commit(authority, next.planId, nextId)
    host.revokeOwner('owner')
    await engine.settled()
    expect(f.store.read(nextId)?.reason).toBe('authority_revoked')
    expect(() => engine.status(authority, id)).toThrow()
    await engine.dispose(); await f.operations.dispose()
  })

  it('rejects insecure or corrupt receipts and does not overwrite hardlinked targets', async () => {
    const f = setup(); const id = randomUUID(); const path = join(f.root, 'receipts', `${id}.json`)
    linkSync(f.file, path)
    expect(() => f.store.read(id)).toThrow('unsafe_receipt')
    unlinkSync(path)
    writeFileSync(path, '{}', { mode: 0o600 })
    expect(() => f.store.read(id)).toThrow()
    chmodSync(path, 0o644)
    expect(() => f.store.read(id)).toThrow('unsafe_receipt')
    expect(() => f.store.read('../escape')).toThrow('invalid_input')
    expect(readFileSync(f.file, 'utf8')).toBe('before')
    await f.operations.dispose()
  })

  it('keeps a confirmed success when cancellation arrives too late', async () => {
    const f = setup(); let entered!: () => void; let finish!: () => void
    const running = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const engine = new ProfileExtensionOperations(f.store, { ...f.executor, execute: async (_p, _v, context) => {
      context.guard(); writeFileSync(f.file, 'committed'); entered()
      await gate
      return { state: 'succeeded' }
    } }, { now: () => 1000 })
    const plan = await engine.prepare(f.authority, 'mcp', 'one'); const id = randomUUID()
    engine.commit(f.authority, plan.planId, id); await running
    expect(engine.cancel(f.authority, id).state).toBe('running')
    finish(); await engine.settled()
    expect(engine.status(f.authority, id)).toMatchObject({ state: 'succeeded', cancellationRequested: true })
    expect(readFileSync(f.file, 'utf8')).toBe('committed')
    await engine.dispose(); await f.operations.dispose()
  })

  it('allows another authorized Profile while one executor is waiting', async () => {
    const f = setup(); const other = randomUUID(); let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const touched: string[] = []
    const engine = new ProfileExtensionOperations(f.store, { ...f.executor, execute: async (p, _v, context) => {
      if (p === f.profileId) await gate
      context.guard(); touched.push(p)
      return { state: 'succeeded' }
    } }, { now: () => 1000 })
    const a = await engine.prepare(f.authority, 'mcp', 'a')
    const b = await engine.prepare(() => other, 'skill', 'b')
    engine.commit(f.authority, a.planId, randomUUID())
    engine.commit(() => other, b.planId, randomUUID())
    await expect.poll(() => touched).toEqual([other])
    finish(); await engine.settled()
    expect(touched).toEqual([other, f.profileId])
    await engine.dispose(); await f.operations.dispose()
  })

})

it('binds checkpoints to the original Skill removal target and refuses rewritten evidence', async () => {
  const f = setup()
  const evidence = { entryId:'flat-demo',originalDigest:hash('body'),beforeRevision:hash('before'),removedRevision:hash('after'),stage:'prepared' as const }
  const owner = new ProfileExtensionOperations(f.store, { revision: f.executor.revision,
    execute: async (_id, _payload, context) => {
      expect(context.operationId).toBeDefined()
      expect(() =>{  context.checkpointSkillRemoval!({ ...evidence,entryId:'flat-other' }) }).toThrow('invalid_checkpoint')
      expect(() =>{  context.checkpointSkillRemoval!({ ...evidence,stage:'removal_verified' }) }).toThrow('invalid_checkpoint')
      context.checkpointSkillRemoval!(evidence)
      expect(() =>{  context.checkpointSkillRemoval!({ ...evidence,originalDigest:hash('forged'),stage:'removed' }) }).toThrow('invalid_checkpoint')
      throw Error('interrupted')
    },
  }, { now:()=>1000 })
  onTestFinished(async () => { await owner.dispose() })
  const plan = await owner.prepare(f.authority,'skill',JSON.stringify({ action:'remove',id:'flat-demo' }))
  const id = randomUUID(); owner.commit(f.authority,plan.planId,id); await owner.settled()
  expect(owner.status(f.authority,id)).toMatchObject({ state:'unknown',skillRemoval:evidence })
  const invalid = { ...f.store.read(id)!,skillRemoval:{ ...evidence,entryId:'../escape' } }
  expect(() =>{  f.store.write(invalid) }).toThrow('invalid_receipt')
})
