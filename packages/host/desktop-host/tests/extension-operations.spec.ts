import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, linkSync, chmodSync, unlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DesktopHost } from '../src/desktop-host.ts'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { FileExtensionReceipts, ProfileExtensionOperations, validateExtensionReceipt, type ExtensionReceipt } from '../src/extension-operations.ts'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const receiptRecord = (): Record<string, unknown> => ({
  version: 1,
  operationId: randomUUID(),
  profileId: randomUUID(),
  planId: randomUUID(),
  kind: 'plugin',
  digest: hash('payload'),
  state: 'running',
  cancellationRequested: false,
  createdAt: 1,
  updatedAt: 2,
})
const durableReceipt = (profileId: string, operationId = randomUUID()): ExtensionReceipt => ({
  version: 1,
  operationId,
  profileId,
  planId: randomUUID(),
  kind: 'mcp',
  digest: hash('payload'),
  state: 'running',
  cancellationRequested: false,
  createdAt: 1,
  updatedAt: 2,
})

it.each([null, false, 'receipt'])('rejects a non-object persisted receipt: %j', (receipt) => {
  expect(() => { validateExtensionReceipt(receipt) }).toThrow('invalid_receipt')
})

it.each([
  ['self restoration', (receipt: Record<string, unknown>) => { receipt.restores = receipt.operationId }],
  ['recovery mode without a restoration', (receipt: Record<string, unknown>) => { receipt.recoveryMode = 'complete' }],
  ['plugin evidence on an MCP receipt', (receipt: Record<string, unknown>) => {
    receipt.kind = 'mcp'
    receipt.pluginToggleRecovery = {
      packageName: 'fixture', backupDigest: hash('backup'), beforeRevision: hash('before'),
      afterRevision: hash('after'), stage: 'prepared',
    }
  }],
  ['duplicate MCP ids', (receipt: Record<string, unknown>) => {
    receipt.kind = 'mcp'
    receipt.mcpRecovery = {
      beforeRevision: hash('before'), afterRevision: hash('after'), originalPresent: true,
      introducedIds: ['mcp-demo', 'mcp-demo'], stage: 'prepared',
    }
  }],
  ['invalid Skill evidence', (receipt: Record<string, unknown>) => {
    receipt.kind = 'skill'
    receipt.skillRemoval = {
      entryId: 'flat-demo', originalDigest: hash('original'), beforeRevision: hash('before'),
      removedRevision: hash('removed'), stage: ['prepared'],
    }
  }],
  ['unexpected metadata', (receipt: Record<string, unknown>) => { receipt.secret = 'must-not-persist' }],
  ['unexpected plugin evidence metadata', (receipt: Record<string, unknown>) => {
    receipt.pluginToggleRecovery = {
      packageName: 'fixture', backupDigest: hash('backup'), beforeRevision: hash('before'),
      afterRevision: hash('after'), stage: 'prepared', secret: 'must-not-persist',
    }
  }],
  ['invalid plugin evidence digest', (receipt: Record<string, unknown>) => {
    receipt.pluginToggleRecovery = {
      packageName: 'fixture', backupDigest: 'invalid', beforeRevision: hash('before'),
      afterRevision: hash('after'), stage: 'prepared',
    }
  }],
  ['array-valued MCP evidence', (receipt: Record<string, unknown>) => {
    receipt.kind = 'mcp'
    receipt.mcpRecovery = []
  }],
  ['invalid MCP evidence digest', (receipt: Record<string, unknown>) => {
    receipt.kind = 'mcp'
    receipt.mcpRecovery = {
      beforeRevision: hash('before'), afterRevision: 'invalid', originalPresent: true,
      introducedIds: ['mcp-demo'], stage: 'prepared',
    }
  }],
  ['array-valued Skill evidence', (receipt: Record<string, unknown>) => {
    receipt.kind = 'skill'
    receipt.skillRemoval = []
  }],
  ['invalid Skill evidence digest', (receipt: Record<string, unknown>) => {
    receipt.kind = 'skill'
    receipt.skillRemoval = {
      entryId: 'flat-demo', originalDigest: 'invalid', beforeRevision: hash('before'),
      removedRevision: hash('removed'), stage: 'prepared',
    }
  }],
] as const)('rejects malformed receipt metadata: %s', (_label, mutate) => {
  const receipt = receiptRecord()
  mutate(receipt)
  expect(() => { validateExtensionReceipt(receipt) }).toThrow('invalid_receipt')
})

it.each([
  ['complete restoration', (receipt: Record<string, unknown>) => {
    receipt.restores = randomUUID()
    receipt.recoveryMode = 'complete'
  }],
  ['plugin toggle recovery', (receipt: Record<string, unknown>) => {
    receipt.pluginToggleRecovery = {
      packageName: '@scope/fixture', backupDigest: hash('backup'), beforeRevision: hash('before'),
      afterRevision: hash('after'), stage: 'restoration_verified',
    }
  }],
  ['MCP recovery', (receipt: Record<string, unknown>) => {
    receipt.kind = 'mcp'
    receipt.mcpRecovery = {
      beforeRevision: hash('before'), afterRevision: hash('after'), originalPresent: false,
      introducedIds: ['mcp-demo'], stage: 'application_verified',
    }
  }],
  ['Skill recovery and source', (receipt: Record<string, unknown>) => {
    receipt.kind = 'skill'
    receipt.state = 'succeeded'
    receipt.skillSource = 'bundled'
    receipt.skillRemoval = {
      entryId: 'bundle-demo', originalDigest: hash('original'), beforeRevision: hash('before'),
      removedRevision: hash('removed'), stage: 'removal_verified',
    }
  }],
  ['failure reason', (receipt: Record<string, unknown>) => { receipt.reason = 'executor_failed' }],
] as const)('accepts bounded receipt metadata: %s', (_label, mutate) => {
  const receipt = receiptRecord()
  mutate(receipt)
  expect(() => { validateExtensionReceipt(receipt) }).not.toThrow()
})

it.each([
  ['uppercase digest', (receipt: Record<string, unknown>) => { receipt.digest = hash('payload').toUpperCase() }],
  ['array-valued state', (receipt: Record<string, unknown>) => { receipt.state = ['running'] }],
  ['unsafe creation time', (receipt: Record<string, unknown>) => { receipt.createdAt = Number.MAX_SAFE_INTEGER + 1 }],
  ['updated before creation', (receipt: Record<string, unknown>) => { receipt.updatedAt = 0 }],
  ['array-valued reason', (receipt: Record<string, unknown>) => { receipt.reason = ['executor_failed'] }],
  ['Skill source on a Plugin receipt', (receipt: Record<string, unknown>) => {
    receipt.state = 'succeeded'
    receipt.skillSource = 'bundled'
  }],
] as const)('rejects invalid receipt core metadata: %s', (_label, mutate) => {
  const receipt = receiptRecord()
  mutate(receipt)
  expect(() => { validateExtensionReceipt(receipt) }).toThrow('invalid_receipt')
})

it.each(['action', 'stage'])('refuses persisted plugin recovery with an array-valued %s', (field) => {
  const f = setup()
  onTestFinished(() => f.operations.dispose())
  const id = randomUUID()
  const intent = { action: 'install' as const, packageName: 'fixture', spec: 'fixture@1.0.0',
    originalSpecDigest: hash('original'), scopeDigest: hash('scope'), removedIds: [], stage: 'prepared' as const }
  f.store.write({ version: 1, operationId: id, profileId: f.profileId, planId: randomUUID(), kind: 'plugin',
    digest: hash('payload'), state: 'running', cancellationRequested: false, createdAt: 1, updatedAt: 2, pluginPackage: intent })
  const file = join(f.root, 'receipts', `${id}.json`)
  const receipt: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof receipt !== 'object' || receipt === null || !('pluginPackage' in receipt)
    || typeof receipt.pluginPackage !== 'object' || receipt.pluginPackage === null) throw new Error('invalid fixture')
  const pluginPackage = receipt.pluginPackage as Record<string, unknown>
  pluginPackage[field] = [pluginPackage[field]]
  const malformed = JSON.stringify(receipt)
  writeFileSync(file, malformed)
  expect(() => f.store.read(id)).toThrow('invalid_receipt')
  expect(readFileSync(file, 'utf8')).toBe(malformed)
  expect(f.executions()).toBe(0)
})

it('refuses an array-valued kind on a persisted restoration receipt', () => {
  const f = setup()
  onTestFinished(() => f.operations.dispose())
  const operationId = randomUUID()
  f.store.write({
    version: 1,
    operationId,
    profileId: f.profileId,
    planId: randomUUID(),
    kind: 'plugin',
    digest: hash('payload'),
    state: 'running',
    cancellationRequested: false,
    createdAt: 1,
    updatedAt: 2,
    restores: randomUUID(),
  })
  const file = join(f.root, 'receipts', `${operationId}.json`)
  const receipt = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  receipt.kind = ['plugin']
  const malformed = JSON.stringify(receipt)
  writeFileSync(file, malformed)

  expect(() => f.store.read(operationId)).toThrow('invalid_receipt')
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
  it('requires the exact preflight script digest before queuing an approved build', async () => {
    const f = setup()
    const scriptDigest = hash('reviewed scripts')
    let approval: unknown
    const operations = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      preflight: async () => ({ buildKey: 'demo@1.0.0', digest: scriptDigest,
        scripts: [{ name: 'postinstall', command: 'node build.js' }] }),
      execute: async (_profileId, _payload, context) => {
        approval = context.buildApproval
        return { state: 'succeeded' as const }
      },
    }, { now: () => 1000 })
    const plan = await operations.prepare(f.authority, 'plugin', 'immutable payload')
    expect(plan.scriptApproval?.scripts).toEqual([{ name: 'postinstall', command: 'node build.js' }])
    expect(() => operations.commit(f.authority, plan.planId, randomUUID())).toThrow('script_approval_required')
    expect(() => operations.commit(f.authority, plan.planId, randomUUID(), undefined, hash('wrong')))
      .toThrow('script_approval_required')
    const id = randomUUID()
    operations.commit(f.authority, plan.planId, id, undefined, scriptDigest)
    await operations.settled()
    expect(approval).toEqual({ buildKey: 'demo@1.0.0', digest: scriptDigest })
    await operations.dispose(); await f.operations.dispose()
  })

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
  it('accepts a safe existing receipt directory and rejects permission drift and identity substitution', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-existing-receipts-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const receipts = join(root, 'receipts')
    mkdirSync(receipts, { mode: 0o700 })
    const store = new FileExtensionReceipts(receipts, process.getuid!())
    const profileId = randomUUID()

    chmodSync(receipts, 0o755)
    expect(() => store.list(profileId)).toThrow('unsafe_receipts')
    chmodSync(receipts, 0o700)

    const requestedId = randomUUID()
    const substituted = receiptRecord()
    writeFileSync(join(receipts, `${requestedId}.json`), JSON.stringify(substituted), { mode: 0o600 })
    expect(substituted.operationId).not.toBe(requestedId)
    expect(() => store.read(requestedId)).toThrow('invalid_receipt')
  })
  it('bounds serialized receipts and removes a temporary file after a lost publication race', async () => {
    const f = setup()
    const originalStringify = JSON.stringify
    const oversized = durableReceipt(f.profileId)
    const sizeSpy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) =>
      value === oversized ? 'x'.repeat(65_537) : originalStringify(value))
    try { expect(() => { f.store.write(oversized) }).toThrow('invalid_receipt') }
    finally { sizeSpy.mockRestore() }

    const raced = durableReceipt(f.profileId)
    const receipts = join(f.root, 'receipts')
    const destination = join(receipts, `${raced.operationId}.json`)
    let serializations = 0
    const raceSpy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      const result = originalStringify(value)
      if (value === raced && ++serializations === 2) mkdirSync(destination)
      return result
    })
    try { expect(() => { f.store.write(raced) }).toThrow() }
    finally { raceSpy.mockRestore() }
    expect(readdirSync(receipts).filter(name => name.endsWith('.tmp'))).toEqual([])
    await f.operations.dispose()
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

  it('rejects malformed recovery plans, missing recovery support and changed prepare authority', async () => {
    const f = setup()
    await expect(f.operations.prepare(f.authority, 'invalid' as never, 'payload')).rejects.toThrow('invalid_input')
    const operationId = randomUUID()
    f.store.write({ version: 1, operationId, profileId: f.profileId, planId: randomUUID(), kind: 'skill',
      digest: hash('payload'), state: 'unknown', cancellationRequested: false, createdAt: 1, updatedAt: 2,
      skillRemoval: { entryId: 'flat-demo', originalDigest: hash('body'), beforeRevision: hash('before'),
        removedRevision: hash('after'), stage: 'prepared' } })
    await expect(f.operations.prepare(f.authority, 'skill', JSON.stringify({ action: 'restore-removal', operationId, extra: true })))
      .rejects.toThrow('invalid_input')
    await expect(f.operations.prepare(f.authority, 'mcp', JSON.stringify({ action: 'restore-config', operationId })))
      .rejects.toThrow('invalid_input')
    await expect(f.operations.prepare(f.authority, 'skill', JSON.stringify({ action: 'restore-removal', operationId })))
      .rejects.toThrow('upgrade_required')
    const blockerId = randomUUID()
    f.store.write({ version: 1, operationId: blockerId, profileId: f.profileId, planId: randomUUID(), kind: 'mcp',
      digest: hash('blocker'), state: 'unknown', cancellationRequested: false, createdAt: 1, updatedAt: 2 })
    const supported = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      validateSkillRestore: async () => {},
      restoreSkillRemoval: async () => ({ state: 'succeeded' }),
    }, { now: () => 1000 })
    await expect(supported.prepare(f.authority, 'skill', JSON.stringify({ action: 'restore-removal', operationId })))
      .rejects.toThrow('busy')
    await supported.dispose()
    expect(() => f.operations.status(() => randomUUID(), operationId)).toThrow('unauthorized')

    const otherProfile = randomUUID()
    let changed = false
    const authority = () => changed ? otherProfile : f.profileId
    const owner = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      revision: async (profileId) => { changed = true; return f.executor.revision(profileId) },
    }, { now: () => 1000 })
    await expect(owner.prepare(authority, 'plugin', 'fixture@1.0.0')).rejects.toThrow('unauthorized')
    await owner.dispose(); await f.operations.dispose()
  })

  it('enforces the plan capacity before and after concurrent revision reads', async () => {
    const f = setup()
    let reads = 0
    let waiting = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const owner = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      revision: async (profileId) => {
        reads++
        if (reads > 127) { waiting++; await gate }
        return f.executor.revision(profileId)
      },
    }, { now: () => 1000 })
    onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })
    for (let index = 0; index < 127; index++) await owner.prepare(f.authority, 'mcp', `plan-${index}`)
    const left = owner.prepare(f.authority, 'mcp', 'left')
    const right = owner.prepare(f.authority, 'mcp', 'right')
    await expect.poll(() => waiting).toBe(2)
    release()
    const outcomes = await Promise.allSettled([left, right])
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = outcomes.find(result => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status !== 'rejected') throw Error('missing rejected plan')
    expect(rejected.reason).toBeInstanceOf(Error)
    expect((rejected.reason as Error).message).toBe('busy')
    await expect(owner.prepare(f.authority, 'mcp', 'overflow')).rejects.toThrow('busy')
  })

  it('expires work both before and after an asynchronous revision check', async () => {
    const f = setup()
    let now = 1000
    let revisionReads = 0
    let revisionStarted!: () => void
    let releaseRevision!: () => void
    const started = new Promise<void>((resolve) => { revisionStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseRevision = resolve })
    const owner = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      revision: async (profileId) => {
        if (++revisionReads === 3) { revisionStarted(); await gate }
        return f.executor.revision(profileId)
      },
    }, { now: () => now })
    onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })

    const firstPlan = await owner.prepare(f.authority, 'mcp', 'first')
    const firstId = randomUUID()
    owner.commit(f.authority, firstPlan.planId, firstId)
    now = firstPlan.expiresAt + 1
    await owner.settled()
    expect(owner.status(f.authority, firstId)).toMatchObject({ state: 'failed', reason: 'expired' })

    const secondPlan = await owner.prepare(f.authority, 'mcp', 'second')
    const secondId = randomUUID()
    owner.commit(f.authority, secondPlan.planId, secondId)
    await started
    now = secondPlan.expiresAt + 1
    releaseRevision()
    await owner.settled()
    expect(owner.status(f.authority, secondId)).toMatchObject({ state: 'failed', reason: 'expired' })
    expect(f.executions()).toBe(0)
  })

  it('fails a committed job when its durable receipt disappears before execution', async () => {
    const f = setup()
    const plan = await f.operations.prepare(f.authority, 'skill', 'fixture')
    const operationId = randomUUID()
    f.operations.commit(f.authority, plan.planId, operationId)
    unlinkSync(join(f.root, 'receipts', `${operationId}.json`))
    await expect(f.operations.settled()).rejects.toThrow('missing_receipt')
    expect(() => f.operations.status(f.authority, operationId)).toThrow('unauthorized')
    expect(f.executions()).toBe(0)
    await f.operations.dispose()
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

  it('cancels after an asynchronous revision read without invoking the executor', async () => {
    const f = setup()
    let revisionReads = 0
    let revisionStarted!: () => void
    let releaseRevision!: () => void
    const started = new Promise<void>((resolve) => { revisionStarted = resolve })
    const gate = new Promise<void>((resolve) => { releaseRevision = resolve })
    const owner = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      revision: async (profileId) => {
        if (++revisionReads === 2) { revisionStarted(); await gate }
        return f.executor.revision(profileId)
      },
    }, { now: () => 1000 })
    onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })
    const plan = await owner.prepare(f.authority, 'mcp', 'fixture')
    const operationId = randomUUID()
    const connection = new AbortController()
    owner.commit(f.authority, plan.planId, operationId, connection.signal)
    await started
    connection.abort()
    releaseRevision()
    await owner.settled()
    expect(owner.status(f.authority, operationId).state).toBe('cancelled')
    expect(f.executions()).toBe(0)
  })

  it('fails closed on revision errors and leaves terminal cancellation unchanged', async () => {
    const f = setup()
    let revisions = 0
    const owner = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      revision: async (profileId) => {
        if (++revisions === 2) throw Error('revision_failed')
        return f.executor.revision(profileId)
      },
    }, { now: () => 1000 })
    onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })
    const plan = await owner.prepare(f.authority, 'plugin', 'fixture@1.0.0')
    const operationId = randomUUID()
    owner.commit(f.authority, plan.planId, operationId)
    await owner.settled()
    expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'failed', reason: 'executor_failed' })
    expect(owner.cancel(f.authority, operationId).cancellationRequested).toBe(false)
    expect(f.executions()).toBe(0)
  })

  it('rejects authority identity drift after the execution revision check', async () => {
    const f = setup()
    const otherProfile = randomUUID()
    let changed = false
    let revisions = 0
    const authority = () => changed ? otherProfile : f.profileId
    const owner = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      revision: async (profileId) => {
        if (++revisions === 2) changed = true
        return f.executor.revision(profileId)
      },
    }, { now: () => 1000 })
    onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })
    const plan = await owner.prepare(authority, 'plugin', 'fixture@1.0.0')
    const operationId = randomUUID()
    owner.commit(authority, plan.planId, operationId)
    await owner.settled()
    expect(f.store.read(operationId)).toMatchObject({ state: 'failed', reason: 'authority_revoked' })
    expect(f.executions()).toBe(0)
  })

  it('normalizes an invalid executor outcome and rejects work after disposal', async () => {
    const f = setup()
    const owner = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      execute: async () => ({ state: 'invalid' as never }),
    }, { now: () => 1000 })
    const plan = await owner.prepare(f.authority, 'skill', 'fixture')
    const operationId = randomUUID()
    owner.commit(f.authority, plan.planId, operationId)
    await owner.settled()
    expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'unknown', reason: 'executor_failed' })
    await owner.dispose()
    await expect(owner.prepare(f.authority, 'skill', 'next')).rejects.toThrow('unavailable')
    await f.operations.dispose()
  })

  it('persists the verified source of a successful Skill operation', async () => {
    const f = setup()
    const owner = new ProfileExtensionOperations(f.store, {
      ...f.executor,
      execute: async (_profileId, _payload, context) => {
        context.guard()
        return { state: 'succeeded', skillSource: 'bundled' }
      },
    }, { now: () => 1000 })
    onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })
    const plan = await owner.prepare(f.authority, 'skill', 'fixture')
    const operationId = randomUUID()
    owner.commit(f.authority, plan.planId, operationId)
    await owner.settled()
    expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'succeeded', skillSource: 'bundled' })
  })

  it('honors connection aborts both before and after commit', async () => {
    const f = setup()
    const firstPlan = await f.operations.prepare(f.authority, 'mcp', 'first')
    const firstId = randomUUID()
    const live = new AbortController()
    f.operations.commit(f.authority, firstPlan.planId, firstId, live.signal)
    live.abort()
    await f.operations.settled()
    expect(f.operations.status(f.authority, firstId).state).toBe('cancelled')

    const secondPlan = await f.operations.prepare(f.authority, 'skill', 'second')
    const secondId = randomUUID()
    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    f.operations.commit(f.authority, secondPlan.planId, secondId, alreadyAborted.signal)
    await f.operations.settled()
    expect(f.operations.status(f.authority, secondId).state).toBe('cancelled')
    expect(f.executions()).toBe(0)
    await f.operations.dispose()
  })

  it('observes receipt storage failure without an unhandled job rejection', async () => {
    const f = setup()
    const store = {
      read: (operationId: string) => f.store.read(operationId),
      list: (profileId: string) => f.store.list(profileId),
      write: (receipt: Parameters<typeof f.store.write>[0]) => {
        if (receipt.state === 'running') throw Error('storage_failed')
        f.store.write(receipt)
      },
    }
    const owner = new ProfileExtensionOperations(store, f.executor, { now: () => 1000 })
    onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })
    const plan = await owner.prepare(f.authority, 'plugin', 'fixture@1.0.0')
    const operationId = randomUUID()
    owner.commit(f.authority, plan.planId, operationId)
    await expect(owner.settled()).rejects.toThrow('storage_failed')
    expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'unknown', reason: 'interrupted' })
    expect(f.executions()).toBe(0)
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
  const removedEvidence = { ...evidence, stage: 'removed' as const }
  let validations = 0
  let restorations = 0
  const owner = new ProfileExtensionOperations(f.store, { revision: f.executor.revision,
    execute: async (_id, _payload, context) => {
      expect(context.operationId).toBeDefined()
      expect(() => { context.checkpointMcp!({ beforeRevision: hash('before'), afterRevision: hash('after'),
        originalPresent: false, introducedIds: [], stage: 'prepared' }) }).toThrow('invalid_checkpoint')
      expect(() =>{  context.checkpointSkillRemoval!({ ...evidence,entryId:'flat-other' }) }).toThrow('invalid_checkpoint')
      expect(() =>{  context.checkpointSkillRemoval!({ ...evidence,stage:'removal_verified' }) }).toThrow('invalid_checkpoint')
      context.checkpointSkillRemoval!(evidence)
      expect(() =>{  context.checkpointSkillRemoval!({ ...evidence,originalDigest:hash('forged'),stage:'removed' }) }).toThrow('invalid_checkpoint')
      expect(() =>{  context.checkpointSkillRemoval!({ ...evidence,beforeRevision:hash('forged'),stage:'removed' }) }).toThrow('invalid_checkpoint')
      expect(() =>{  context.checkpointSkillRemoval!({ ...evidence,removedRevision:hash('forged'),stage:'removed' }) }).toThrow('invalid_checkpoint')
      context.checkpointSkillRemoval!(removedEvidence)
      throw Error('interrupted')
    },
    validateSkillRestore: async (_profileId, original) => {
      validations++
      expect(original.skillRemoval).toEqual(removedEvidence)
    },
    restoreSkillRemoval: async (_profileId, original, context) => {
      context.guard()
      restorations++
      expect(original.skillRemoval).toEqual(removedEvidence)
      return { state: 'succeeded' }
    },
  }, { now:()=>1000 })
  onTestFinished(async () => { await owner.dispose() })
  const plan = await owner.prepare(f.authority,'skill',JSON.stringify({ action:'remove',id:'flat-demo' }))
  const id = randomUUID(); owner.commit(f.authority,plan.planId,id); await owner.settled()
  expect(owner.status(f.authority,id)).toMatchObject({ state:'unknown',skillRemoval:removedEvidence })
  const invalid = { ...f.store.read(id)!,skillRemoval:{ ...evidence,entryId:'../escape' } }
  expect(() =>{  f.store.write(invalid) }).toThrow('invalid_receipt')
  expect(owner.status(f.authority, id)).toMatchObject({ canRestore: true })
  const recovery = await owner.prepare(f.authority, 'skill', JSON.stringify({ action: 'restore-removal', operationId: id }))
  const recoveryId = randomUUID()
  owner.commit(f.authority, recovery.planId, recoveryId)
  await owner.settled()
  expect(validations).toBe(1)
  expect(restorations).toBe(1)
  expect(owner.status(f.authority, recoveryId).state).toBe('succeeded')
  expect(owner.status(f.authority, id)).toMatchObject({ state: 'unknown', restoredBy: recoveryId })
})

it('restores checkpointed MCP configuration without accepting rewritten evidence', async () => {
  const f = setup()
  const prepared = { beforeRevision: hash('before'), afterRevision: hash('after'), originalPresent: true,
    introducedIds: ['mcp-demo'], stage: 'prepared' as const }
  const published = { ...prepared, stage: 'published' as const }
  const owner = new ProfileExtensionOperations(f.store, {
    revision: f.executor.revision,
    execute: async (_profileId, _payload, context) => {
      expect(() => { context.checkpointSkillRemoval!({ entryId: 'flat-demo', originalDigest: hash('body'),
        beforeRevision: hash('before'), removedRevision: hash('after'), stage: 'prepared' }) }).toThrow('invalid_checkpoint')
      context.checkpointMcp!(prepared)
      expect(() => { context.checkpointMcp!({ ...prepared, stage: 'restoration_verified' }) }).toThrow('invalid_checkpoint')
      context.checkpointMcp!(published)
      expect(() => { context.checkpointMcp!({ ...published, introducedIds: ['rewritten'] }) }).toThrow('invalid_checkpoint')
      throw Error('interrupted')
    },
    validateMcpRestore: async (_profileId, original) => { expect(original.mcpRecovery).toEqual(published) },
    restoreMcpConfig: async (_profileId, original, context) => {
      context.guard()
      expect(original.mcpRecovery).toEqual(published)
      return { state: 'succeeded' }
    },
  }, { now: () => 1000 })
  onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })

  const plan = await owner.prepare(f.authority, 'mcp', 'install mcp-demo')
  const operationId = randomUUID()
  owner.commit(f.authority, plan.planId, operationId)
  await owner.settled()
  expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'unknown', mcpRecovery: published, canRestore: true })

  const recovery = await owner.prepare(f.authority, 'mcp', JSON.stringify({ action: 'restore-config', operationId }))
  const recoveryId = randomUUID()
  owner.commit(f.authority, recovery.planId, recoveryId)
  await owner.settled()
  expect(owner.status(f.authority, recoveryId).state).toBe('succeeded')
  expect(owner.status(f.authority, operationId).restoredBy).toBe(recoveryId)
})

it('restores checkpointed Plugin toggle state bound to its package', async () => {
  const f = setup()
  const prepared = { packageName: '@scope/demo', backupDigest: hash('backup'), beforeRevision: hash('before'),
    afterRevision: hash('after'), stage: 'prepared' as const }
  const published = { ...prepared, stage: 'published' as const }
  const owner = new ProfileExtensionOperations(f.store, {
    revision: f.executor.revision,
    execute: async (_profileId, _payload, context) => {
      expect(() => { context.checkpointPluginToggle!({ ...prepared, packageName: '@scope/other' }) }).toThrow('invalid_checkpoint')
      context.checkpointPluginToggle!(prepared)
      expect(() => { context.checkpointPluginToggle!({ ...published, backupDigest: hash('rewritten') }) }).toThrow('invalid_checkpoint')
      expect(() => { context.checkpointPluginToggle!({ ...prepared, stage: 'restoration_verified' }) }).toThrow('invalid_checkpoint')
      context.checkpointPluginToggle!(published)
      throw Error('interrupted')
    },
    validatePluginRestore: async (_profileId, original) => { expect(original.pluginToggleRecovery).toEqual(published) },
    restorePluginToggle: async (_profileId, original, context) => {
      context.guard()
      expect(original.pluginToggleRecovery).toEqual(published)
      return { state: 'succeeded' }
    },
  }, { now: () => 1000 })
  onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })

  const plan = await owner.prepare(f.authority, 'plugin', JSON.stringify({ action: 'toggle', packageName: '@scope/demo' }))
  const operationId = randomUUID()
  owner.commit(f.authority, plan.planId, operationId)
  await owner.settled()
  expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'unknown', pluginToggleRecovery: published, canRestore: true })

  const recovery = await owner.prepare(f.authority, 'plugin', JSON.stringify({ action: 'restore-toggle', operationId }))
  const recoveryId = randomUUID()
  owner.commit(f.authority, recovery.planId, recoveryId)
  await owner.settled()
  expect(owner.status(f.authority, recoveryId).state).toBe('succeeded')
  expect(owner.status(f.authority, operationId).restoredBy).toBe(recoveryId)
})

it('completes an interrupted Plugin package operation from immutable intent', async () => {
  const f = setup()
  const prepared = { action: 'install' as const, packageName: 'fixture', spec: 'fixture@1.0.0',
    originalSpecDigest: hash('original'), scopeDigest: hash('scope'), removedIds: [], stage: 'prepared' as const }
  const commandCompleted = { ...prepared, stage: 'command_completed' as const }
  const verified = { ...prepared, stage: 'verified' as const }
  let completions = 0
  const owner = new ProfileExtensionOperations(f.store, {
    revision: f.executor.revision,
    execute: async (_profileId, _payload, context) => {
      expect(() => { context.checkpointPluginPackage!({ ...prepared, stage: ['prepared'] as never }) }).toThrow('invalid_checkpoint')
      expect(() => { context.checkpointPluginPackage!({ ...prepared, packageName: 'other', spec: 'other@1.0.0' }) }).toThrow('invalid_checkpoint')
      context.checkpointPluginPackage!(prepared)
      expect(() => { context.checkpointPluginPackage!({ ...commandCompleted, scopeDigest: hash('rewritten') }) }).toThrow('invalid_checkpoint')
      expect(() => { context.checkpointPluginPackage!(prepared) }).toThrow('invalid_checkpoint')
      context.checkpointPluginPackage!(commandCompleted)
      context.checkpointPluginPackage!(verified)
      throw Error('interrupted')
    },
    validatePluginCompletion: async (_profileId, original) => { expect(original.pluginPackage).toEqual(verified) },
    completePluginPackage: async (_profileId, original, context) => {
      context.guard()
      completions++
      expect(original.pluginPackage).toEqual(verified)
      context.checkpointPluginPackage!(prepared)
      context.checkpointPluginPackage!(commandCompleted)
      context.checkpointPluginPackage!(verified)
      return { state: 'succeeded' }
    },
  }, { now: () => 1000 })
  onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })

  const plan = await owner.prepare(f.authority, 'plugin', JSON.stringify({ packageName: 'fixture', spec: 'fixture@1.0.0' }))
  const operationId = randomUUID()
  owner.commit(f.authority, plan.planId, operationId)
  await owner.settled()
  expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'unknown', pluginPackage: verified, canComplete: true })

  const completionPayload = JSON.stringify({ action: 'complete-package', operationId })
  const original = f.store.read(operationId)!
  const staleCompletion = await owner.prepare(f.authority, 'plugin', completionPayload)
  f.store.write({ ...original, pluginPackage: { ...verified, scopeDigest: hash('rewritten') } })
  const staleCompletionId = randomUUID()
  owner.commit(f.authority, staleCompletion.planId, staleCompletionId)
  await owner.settled()
  expect(owner.status(f.authority, staleCompletionId).state).toBe('unknown')
  expect(completions).toBe(0)

  f.store.write(original)
  const completion = await owner.prepare(f.authority, 'plugin', completionPayload)
  const completionId = randomUUID()
  owner.commit(f.authority, completion.planId, completionId)
  await owner.settled()
  expect(completions).toBe(1)
  expect(owner.status(f.authority, completionId)).toMatchObject({ state: 'succeeded', recoveryMode: 'complete' })
  expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'unknown', completedBy: completionId })
})

it('fails closed when a prepared recovery executor disappears before commit', async () => {
  const f = setup()
  const operationId = randomUUID()
  const evidence = { entryId: 'flat-demo', originalDigest: hash('body'), beforeRevision: hash('before'),
    removedRevision: hash('after'), stage: 'prepared' as const }
  f.store.write({ version: 1, operationId, profileId: f.profileId, planId: randomUUID(), kind: 'skill',
    digest: hash('payload'), state: 'unknown', cancellationRequested: false, createdAt: 1, updatedAt: 2,
    skillRemoval: evidence })
  const executor = {
    revision: f.executor.revision,
    execute: f.executor.execute,
    validateSkillRestore: async () => {},
    restoreSkillRemoval: async () => ({ state: 'succeeded' as const }),
  }
  const owner = new ProfileExtensionOperations(f.store, executor, { now: () => 1000 })
  onTestFinished(async () => { await owner.dispose(); await f.operations.dispose() })
  const plan = await owner.prepare(f.authority, 'skill', JSON.stringify({ action: 'restore-removal', operationId }))
  Reflect.deleteProperty(executor, 'restoreSkillRemoval')
  const recoveryId = randomUUID()
  owner.commit(f.authority, plan.planId, recoveryId)
  await owner.settled()
  expect(owner.status(f.authority, recoveryId)).toMatchObject({ state: 'unknown', reason: 'executor_failed' })
  expect(owner.status(f.authority, operationId)).toMatchObject({ state: 'unknown' })
  expect(owner.status(f.authority, operationId).canRestore).toBeUndefined()
})
