import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import { ProfilePluginExecutor } from '../src/profile-plugin-executor.ts'

function fixture(acknowledged = true) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-executor-'))
  const web = join(root, 'profiles/web'); mkdirSync(web, { recursive: true, mode: 0o700 })
  const manifest = join(web, 'package.json'); writeFileSync(manifest, '{}', { mode: 0o600 })
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  let calls = 0
  const executor = new ProfilePluginExecutor({
    resolve: () => root, uid: process.getuid!(),
    install: async (_root, _spec, context) => {
      context.guard(); calls++
      writeFileSync(manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
    },
    acknowledge: async () => { if (!acknowledged) throw Error('startup failed with private output') },
  })
  const store = new FileExtensionReceipts(join(root, 'receipts'), process.getuid!())
  const operations = new ProfileExtensionOperations(store, executor, { now: Date.now })
  onTestFinished(async () => { await operations.dispose() })
  const profileId = randomUUID(); const authority = () => profileId
  return { root, web, manifest, executor, store, operations, authority, calls: () => calls }
}
const payload = JSON.stringify({ packageName: 'fixture', spec: 'fixture@1.0.0' })
it('refuses a symlink manifest before installing without changing its target', () => {
  const f = fixture()
  const target = join(f.root, 'preserved-package.json')
  renameSync(f.manifest, target)
  symlinkSync(target, f.manifest)
  expect(() => f.executor.validate(f.authority(), 'plugin', payload))
    .toThrowError(expect.objectContaining({ code: 'ELOOP' }))
  expect(f.calls()).toBe(0)
  expect(readFileSync(target, 'utf8')).toBe('{}')
})
it('persists success after acknowledgement and does not repeat a confirmed install', async () => {
  const f = fixture(); const plan = await f.operations.prepare(f.authority, 'plugin', payload); const id = randomUUID()
  f.operations.commit(f.authority, plan.planId, id); f.operations.commit(f.authority, plan.planId, id)
  await f.operations.settled()
  expect(f.operations.status(f.authority, id).state).toBe('succeeded'); expect(f.calls()).toBe(1)
  expect(readFileSync(f.manifest, 'utf8')).toContain('fixture')
})
it('leaves failed activation unknown and blocks replay after a partial install', async () => {
  const f = fixture(false); const plan = await f.operations.prepare(f.authority, 'plugin', payload); const id = randomUUID()
  f.operations.commit(f.authority, plan.planId, id); await f.operations.settled()
  expect(f.operations.status(f.authority, id).state).toBe('unknown')
  expect(JSON.stringify(f.store.list(f.authority()))).not.toContain('private output')
  expect(() => { f.executor.validate(f.authority(), 'plugin', payload) }).toThrow('plugin_already_installed')
})
it('rejects changed lockfiles before installing and rejects mutable or mismatched input', async () => {
  const f = fixture(); const plan = await f.operations.prepare(f.authority, 'plugin', payload)
  writeFileSync(join(f.web, 'pnpm-lock.yaml'), 'changed', { mode: 0o600 })
  const id = randomUUID(); f.operations.commit(f.authority, plan.planId, id); await f.operations.settled()
  expect(f.operations.status(f.authority, id).reason).toBe('revision_conflict'); expect(f.calls()).toBe(0)
  for (const value of [ { packageName: 'fixture', spec: 'fixture@latest' }, { packageName: 'other', spec: 'fixture@1.0.0' },
    { packageName: 'fixture', spec: 'fixture@1.0.0', profileRoot: '/tmp/other' } ]) {
    expect(() => { f.executor.validate(f.authority(), 'plugin', JSON.stringify(value)) }).toThrow()
  }
})

it('does not acknowledge success if configuration changes during activation', async () => {
  const f = fixture()
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => { writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } })) },
    acknowledge: async () => { writeFileSync(join(f.web, 'cordis.patch.yml'), 'changed', { mode: 0o600 }) },
  })
  await expect(executor.execute(f.authority(), payload, { kind: 'plugin', signal: new AbortController().signal, guard() {} }))
    .rejects.toThrow('plugin_state_changed')
})

it('atomically toggles an installed bundle and restores the exact patch after failed acknowledgement', async () => {
  const { planPluginToggle } = await import('../src/plugin-toggle-plan.ts')
  const f = fixture(); const file = join(f.web, 'cordis.patch.yml')
  const original = '# keep\n[]\n'; writeFileSync(file, original, { mode: 0o600 })
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
  const layers = [{ packageName: 'fixture', patches: [{ insert: [{ id: 'tool', name: 'fixture-tool' }] }] }]
  let fail = true; const observations: string[] = []
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(), install: async () => { throw Error('unexpected install') },
    acknowledge: async () => { throw Error('unexpected install acknowledgement') },
    togglePlan: (_id, name, enabled) => planPluginToggle(layers, readFileSync(file, 'utf8'), [], name, enabled),
    acknowledgeToggle: async (_id, plan) => {
      observations.push(plan.disabled.length ? 'disabled' : 'enabled')
      if (fail) { fail = false; throw Error('reload failed') }
    },
  })
  const context = { kind: 'plugin' as const, signal: new AbortController().signal, guard() {} }
  const payload = JSON.stringify({ action: 'toggle', packageName: 'fixture', enabled: false })
  expect(await executor.execute(f.authority(), payload, context)).toEqual({ state: 'failed' })
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(observations).toEqual(['disabled', 'enabled'])
  expect(await executor.execute(f.authority(), payload, context)).toEqual({ state: 'succeeded' })
  expect(readFileSync(file, 'utf8')).toContain('disabled: true')
  expect(readFileSync(f.manifest, 'utf8')).toContain('fixture')
  expect(() => { executor.validate(f.authority(), 'plugin', JSON.stringify({ action: 'toggle', packageName: 'other', enabled: false })) }).toThrow()
})

it('updates only an installed independently enabled bundle to the confirmed exact source', async () => {
  const { planPluginToggle } = await import('../src/plugin-toggle-plan.ts')
  const f = fixture()
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
  let calls = 0; let enabled = true
  const layers = [{ packageName: 'fixture', patches: [{ insert: [{ id: 'tool', name: 'fixture-tool' }] }] }]
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    togglePlan: (_id, name, value) => planPluginToggle(layers, enabled ? '' : '- id: tool\n  disabled: true\n', [], name, value),
    acknowledgeToggle: async () => {}, acknowledge: async () => { calls++ },
    install: async (_root, spec) => {
      expect(spec).toBe('fixture@2.0.0')
      writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '2.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
    },
  })
  const payload = JSON.stringify({ action: 'update', packageName: 'fixture', spec: 'fixture@2.0.0' })
  expect(await executor.execute(f.authority(), payload, { kind:'plugin',signal:new AbortController().signal,guard(){} })).toEqual({ state:'succeeded' })
  expect(calls).toBe(1)
  enabled = false
  expect(() => { executor.validate(f.authority(), 'plugin', payload) }).toThrow()
  for (const value of [{ action:'update',packageName:'other',spec:'other@2.0.0' }, { action:'update',packageName:'fixture',spec:'fixture@latest' }]) {
    expect(() => { executor.validate(f.authority(), 'plugin', JSON.stringify(value)) }).toThrow()
  }
})
it('removes an installed bundle, clears its standalone toggle override and requires runtime absence', async () => {
  const { planPluginToggle } = await import('../src/plugin-toggle-plan.ts')
  const f = fixture(); const file = join(f.web, 'cordis.patch.yml')
  writeFileSync(file, '# keep\n- id: tool\n  disabled: true\n- id: other\n  config:\n    secret: !!js process.platform\n', { mode:0o600 })
  writeFileSync(f.manifest, JSON.stringify({ dependencies:{ fixture:'1.0.0' },dsh:{ profile:{ bundles:['fixture'] } } }))
  const layers=[{ packageName:'fixture',patches:[{ insert:[{ id:'tool',name:'fixture-tool' }] }] }]
  let acknowledged=false
  const executor=new ProfilePluginExecutor({ resolve:()=>f.root,uid:process.getuid!(),install:async()=>{},acknowledge:async()=>{},
    togglePlan:(_id,name,enabled,patch)=>planPluginToggle(layers,patch,[],name,enabled),acknowledgeToggle:async()=>{},
    remove:async(_root,name)=>{expect(name).toBe('fixture');writeFileSync(f.manifest,JSON.stringify({ dependencies:{},dsh:{ profile:{ bundles:[] } } }))},
    acknowledgeRemoval:async(_id,ids)=>{expect(ids).toEqual(['include:tool']);acknowledged=true},
  })
  expect(await executor.execute(f.authority(),JSON.stringify({ action:'remove',packageName:'fixture' }),{ kind:'plugin',signal:new AbortController().signal,guard(){} })).toEqual({ state:'succeeded' })
  expect(acknowledged).toBe(true)
  expect(await executor.inventory(f.authority())).toEqual([])
  expect(readFileSync(file,'utf8')).not.toContain('disabled: true')
  expect(readFileSync(file,'utf8')).toContain('!!js process.platform')
})


it.each([null, '', '# keep\n[]\n'])('recovers interrupted plugin activation and rejects changed dependencies (original %j)', async (original) => {
  const { planPluginToggle } = await import('../src/plugin-toggle-plan.ts')
  const f = fixture(); const file = join(f.web, 'cordis.patch.yml')
  if (original !== null) writeFileSync(file, original, { mode: 0o600 })
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
  const manifest = readFileSync(f.manifest, 'utf8')
  const layers = [{ packageName: 'fixture', patches: [{ insert: [{ id: 'tool', name: 'fixture-tool' }] }] }]
  let confirmed = false; let acknowledgements = 0
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => { throw Error('must not reinstall') }, acknowledge: async () => { throw Error('must not reinstall') },
    togglePlan: (_id, name, enabled, patch) => planPluginToggle(layers, patch, [], name, enabled),
    acknowledgeToggle: async (_id, plan) => {
      acknowledgements++
      expect(plan.expected).toEqual([{ entryId: 'include:tool', moduleName: 'fixture-tool' }]); expect(plan.disabled).toEqual([])
      if (!confirmed) throw Error('restoration acknowledgement unavailable')
    },
  })
  const execute = executor.execute.bind(executor)
  executor.execute = (profileId, input, context) => execute(profileId, input, { ...context, checkpointPluginToggle: (evidence) => {
    context.checkpointPluginToggle?.(evidence)
    if (evidence.stage === 'published') throw Error('interrupted after publication')
  } })
  let operations = new ProfileExtensionOperations(f.store, executor, { now: Date.now })
  const plan = await operations.prepare(f.authority, 'plugin', JSON.stringify({ action: 'toggle', packageName: 'fixture', enabled: false }))
  const id = randomUUID(); operations.commit(f.authority, plan.planId, id); await operations.settled()
  expect(operations.status(f.authority, id)).toMatchObject({ state: 'unknown', canRestore: true })
  expect(acknowledgements).toBe(0)
  await operations.dispose(); operations = new ProfileExtensionOperations(f.store, executor, { now: Date.now })
  const restore = JSON.stringify({ action: 'restore-toggle', operationId: id })
  const backup = join(f.web, `.plugin-before-${id}`); const backupBytes = readFileSync(backup, 'utf8')
  writeFileSync(backup, '1# tampered')
  await expect(operations.prepare(f.authority, 'plugin', restore)).rejects.toThrow('invalid_backup')
  writeFileSync(backup, backupBytes); chmodSync(backup, 0o644)
  await expect(operations.prepare(f.authority, 'plugin', restore)).rejects.toThrow('unsafe_backup')
  chmodSync(backup, 0o600)
  await expect(operations.prepare(() => randomUUID(), 'plugin', restore)).rejects.toThrow('unauthorized')
  writeFileSync(f.manifest, manifest + ' ')
  await expect(operations.prepare(f.authority, 'plugin', restore)).rejects.toThrow('plugin_state_changed')
  writeFileSync(f.manifest, manifest)
  const first = await operations.prepare(f.authority, 'plugin', restore); const firstId = randomUUID()
  operations.commit(f.authority, first.planId, firstId); await operations.settled()
  expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(original)
  expect(operations.status(f.authority, firstId)).toMatchObject({ state: 'unknown', restores: id })
  confirmed = true
  const retry = await operations.prepare(f.authority, 'plugin', restore); const retryId = randomUUID()
  operations.commit(f.authority, retry.planId, retryId); await operations.settled()
  expect(operations.status(f.authority, retryId)).toMatchObject({ state: 'succeeded', restores: id })
  expect(operations.status(f.authority, id)).toMatchObject({ state: 'unknown', restoredBy: retryId })
  expect(operations.status(f.authority, firstId)).toMatchObject({ state: 'unknown', restoredBy: retryId })
  expect(readFileSync(f.manifest, 'utf8')).toBe(manifest)
  await operations.dispose()
})


it.each(['install', 'update', 'remove'] as const)('explicitly completes an interrupted package %s without rewriting its history', async (action) => {
  const f = fixture(); let commands = 0; let repairs = 0; let acknowledgements = 0; let runtimeReady = false
  const before = { dependencies: { keep: '1.0.0', ...(action === 'install' ? {} : { fixture: '1.0.0' }) },
    dsh: { profile: { bundles: action === 'install' ? ['keep'] : ['keep', 'fixture'] } } }
  writeFileSync(f.manifest, JSON.stringify(before))
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => {
      commands++
      writeFileSync(f.manifest, JSON.stringify({ ...before, dependencies: { keep: '1.0.0', fixture: '2.0.0' },
        dsh: { profile: { bundles: commands === 1 ? before.dsh.profile.bundles : ['keep', 'fixture'] } } }))
      if (commands === 1) throw Error('interrupted after dependency write')
    },
    remove: async () => {
      commands++
      writeFileSync(f.manifest, JSON.stringify({ ...before, dependencies: { keep: '1.0.0' } }))
      throw Error('interrupted before bundle reconciliation')
    },
    repair: async () => { repairs++ },
    togglePlan: () => ({ patch: '', previousExpected: [{ entryId: 'include:fixture', moduleName: 'fixture' }],
      previousDisabled: [], expected: [], disabled: [] }),
    acknowledgeToggle: async () => {},
    acknowledgeRemoval: async (_id, ids) => { expect(ids).toEqual(['include:fixture']); acknowledgements++; if (!runtimeReady) throw Error('runtime unconfirmed') },
    acknowledge: async () => { acknowledgements++; if (!runtimeReady) throw Error('runtime unconfirmed') },
  })
  let operations = new ProfileExtensionOperations(f.store, executor, { now: Date.now })
  const request = action === 'remove' ? { action, packageName: 'fixture' }
    : { ...(action === 'update' ? { action } : {}), packageName: 'fixture', spec: 'fixture@2.0.0' }
  const plan = await operations.prepare(f.authority, 'plugin', JSON.stringify(request)); const id = randomUUID()
  operations.commit(f.authority, plan.planId, id); await operations.settled()
  expect(operations.status(f.authority, id)).toMatchObject({ state: 'unknown', canComplete: true, pluginPackage: { action, stage: 'prepared' } })
  expect(acknowledgements).toBe(0)
  await operations.dispose(); operations = new ProfileExtensionOperations(f.store, executor, { now: Date.now })
  const complete = JSON.stringify({ action: 'complete-package', operationId: id })
  const partial = readFileSync(f.manifest, 'utf8')
  writeFileSync(f.manifest, partial.replace('"keep":"1.0.0"', '"keep":"2.0.0"'))
  await expect(operations.prepare(f.authority, 'plugin', complete)).rejects.toThrow('plugin_scope_changed')
  writeFileSync(f.manifest, partial)
  const firstCompletion = await operations.prepare(f.authority, 'plugin', complete); const firstId = randomUUID()
  operations.commit(f.authority, firstCompletion.planId, firstId); await operations.settled()
  expect(operations.status(f.authority, firstId)).toMatchObject({ state: 'unknown', recoveryMode: 'complete', restores: id })
  runtimeReady = true
  const completion = await operations.prepare(f.authority, 'plugin', complete); const completionId = randomUUID()
  expect(commands).toBe(action === 'remove' ? 1 : 2)
  operations.commit(f.authority, completion.planId, completionId); await operations.settled()
  expect(operations.status(f.authority, completionId)).toMatchObject({ state: 'succeeded', recoveryMode: 'complete', restores: id })
  expect(operations.status(f.authority, id)).toMatchObject({ state: 'unknown', completedBy: completionId })
  expect(operations.status(f.authority, id).canComplete).toBeUndefined()
  expect(operations.status(f.authority, id).restoredBy).toBeUndefined()
  expect(operations.status(f.authority, firstId)).toMatchObject({ state: 'unknown', completedBy: completionId })
  expect(acknowledgements).toBe(2); expect(commands).toBe(action === 'remove' ? 1 : 3); expect(repairs).toBe(action === 'remove' ? 2 : 0)
  const installed = JSON.parse(readFileSync(f.manifest, 'utf8')) as { dependencies: { keep: string }; dsh: { profile: { bundles: string[] } } }
  expect(installed.dependencies.keep).toBe('1.0.0')
  expect(installed.dsh.profile.bundles).toEqual(action === 'remove' ? ['keep'] : ['keep', 'fixture'])
  await operations.dispose()
})


it('preserves unrelated dsh metadata when installation creates the first bundle registration', async () => {
  const f = fixture(); writeFileSync(f.manifest, JSON.stringify({ dsh: { note: 'keep' } }))
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => { writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { note: 'keep', profile: { bundles: ['fixture'] } } })) },
    acknowledge: async () => {},
  })
  expect(await executor.execute(f.authority(), payload, { kind: 'plugin', signal: new AbortController().signal, guard() {} })).toEqual({ state: 'succeeded' })
})


it('does not acknowledge a Git update still registered at its original commit', async () => {
  const f = fixture(); const previous = `github:owner/plugin#${'b'.repeat(40)}`; const requested = `github:owner/plugin#${'a'.repeat(40)}`
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: previous }, dsh: { profile: { bundles: ['fixture'] } } }))
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(), install: async () => {},
    togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }),
    acknowledgeToggle: async () => {}, acknowledge: async () => { throw Error('must not acknowledge an old commit') },
  })
  await expect(executor.execute(f.authority(), JSON.stringify({ action: 'update', packageName: 'fixture', spec: requested }),
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toThrow('plugin_version_mismatch')
})
