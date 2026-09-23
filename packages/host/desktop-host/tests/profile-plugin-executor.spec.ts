import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { FileExtensionReceipts, ProfileExtensionOperations, type ExtensionReceipt } from '../src/extension-operations.ts'
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

it('preflights only new plugin installs when an inspector is available', async () => {
  const f = fixture()
  const approval = { scripts: [{ name: 'postinstall' as const, command: 'node build.js' }], digest: 'a'.repeat(64), buildKey: 'fixture@1.0.0' }
  const inspectScripts = vi.fn(async () => approval)
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(), install: async () => {},
    acknowledge: async () => {}, inspectScripts })
  await expect(executor.preflight(f.authority(), 'plugin', payload)).resolves.toEqual(approval)
  expect(inspectScripts).toHaveBeenCalledWith('fixture', 'fixture@1.0.0')
  await expect(executor.preflight(f.authority(), 'plugin', JSON.stringify({ action: 'remove', packageName: 'fixture' })))
    .resolves.toBeUndefined()
  await expect(executor.preflight('not-a-profile', 'mcp', 'not-json')).resolves.toBeUndefined()
  await expect(f.executor.preflight(f.authority(), 'plugin', payload)).resolves.toBeUndefined()
})
it.each([
  ['null', null],
  ['array', []],
  ['string', 'fixture'],
  ['remove missing name', { action: 'remove' }],
  ['remove extra field', { action: 'remove', packageName: 'fixture', extra: true }],
  ['remove invalid name', { action: 'remove', packageName: '../fixture' }],
  ['update extra field', { action: 'update', packageName: 'fixture', spec: 'fixture@1.0.0', extra: true }],
  ['toggle missing state', { action: 'toggle', packageName: 'fixture' }],
  ['toggle array state', { action: 'toggle', packageName: 'fixture', enabled: [true] }],
] as const)('rejects malformed plugin input before reading Profile state: %s', (_label, value) => {
  const f = fixture()
  expect(() => { f.executor.validate(f.authority(), 'plugin', JSON.stringify(value)) }).toThrow('invalid_plugin_input')
  expect(f.calls()).toBe(0)
})

it('rejects unsupported kinds, relative roots, unsafe Profile directories, and malformed manifests', () => {
  const f = fixture()
  expect(() => { f.executor.validate(f.authority(), 'skill', payload) }).toThrow('upgrade_required')
  const relative = new ProfilePluginExecutor({ resolve: () => 'relative', uid: process.getuid!(), install: async () => {},
    acknowledge: async () => {} })
  expect(() => { relative.validate(f.authority(), 'plugin', payload) }).toThrow('unsafe_profile')
  chmodSync(f.web, 0o777)
  expect(() => { f.executor.validate(f.authority(), 'plugin', payload) }).toThrow('unsafe_profile')
  chmodSync(f.web, 0o700)
  for (const manifest of [null, [], { dependencies: [] }, { dsh: [] }, { dsh: { profile: [] } }]) {
    writeFileSync(f.manifest, JSON.stringify(manifest), { mode: 0o600 })
    expect(() => { f.executor.validate(f.authority(), 'plugin', payload) }).toThrow('invalid_profile_manifest')
  }
  unlinkSync(f.manifest)
  expect(() => { f.executor.validate(f.authority(), 'plugin', payload) }).toThrow('invalid_profile_manifest')
})

it('reports enabled, disabled, mixed, unsupported, and unavailable plugin toggle states', async () => {
  const f = fixture()
  const names = ['enabled', 'disabled', 'mixed', 'unsupported']
  writeFileSync(f.manifest, JSON.stringify({ dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])),
    dsh: { profile: { bundles: [...names, 'unmanaged'] } } }), { mode: 0o600 })
  const expected = { entryId: 'include:expected', moduleName: 'expected' }
  const disabled = { entryId: 'include:disabled', moduleName: 'disabled' }
  const togglePlan = vi.fn((_profileId: string, name: string) => {
    if (name === 'unsupported') throw Error('unsupported composition')
    return { patch: '', expected: [], disabled: [],
      previousExpected: name === 'mixed' ? [expected] : [],
      previousDisabled: name === 'enabled' ? [] : [disabled] }
  })
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(), install: async () => {},
    acknowledge: async () => {}, togglePlan, acknowledgeToggle: async () => {} })
  expect(await executor.inventory(f.authority())).toEqual([
    expect.objectContaining({ name: 'enabled', plugin_state: 'enabled' }),
    expect.objectContaining({ name: 'disabled', plugin_state: 'disabled' }),
    expect.objectContaining({ name: 'mixed', plugin_state: 'mixed' }),
    expect.objectContaining({ name: 'unsupported', plugin_state: 'unsupported' }),
    expect.objectContaining({ name: 'unmanaged', plugin_state: 'unsupported' }),
  ])
  const withoutToggle = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(), install: async () => {},
    acknowledge: async () => {} })
  expect((await withoutToggle.inventory(f.authority())).map(({ name, plugin_state }) => ({ name, plugin_state })))
    .toEqual([...names, 'unmanaged'].map(name => ({ name, plugin_state: undefined })))
})

it('rejects malformed and oversized plugin inventory entries', async () => {
  const f = fixture()
  for (const bundles of [null, Array.from({ length: 129 }, (_, index) => `plugin-${index}`), ['valid', ['array']], ['../escape']]) {
    writeFileSync(f.manifest, JSON.stringify({ dsh: { profile: { bundles } } }), { mode: 0o600 })
    await expect(f.executor.inventory(f.authority())).rejects.toThrow('invalid_profile_manifest')
  }
})

it('enforces managed bundle uniqueness and required action capabilities', () => {
  const f = fixture()
  const action = (value: object) => JSON.stringify({ packageName: 'fixture', ...value })
  const manifest = (bundles: string[]) => {
    writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles } } }), { mode: 0o600 })
  }
  manifest([])
  expect(() => { f.executor.validate(f.authority(), 'plugin', action({ action: 'toggle', enabled: false })) })
    .toThrow('plugin_bundle_missing')
  manifest(['fixture', 'fixture'])
  expect(() => { f.executor.validate(f.authority(), 'plugin', action({ action: 'toggle', enabled: false })) })
    .toThrow('plugin_bundle_missing')
  manifest(['fixture'])
  expect(() => { f.executor.validate(f.authority(), 'plugin', action({ action: 'toggle', enabled: false })) })
    .toThrow('upgrade_required')

  const base = { resolve: () => f.root, uid: process.getuid!(), install: async () => {}, acknowledge: async () => {},
    togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }),
    acknowledgeToggle: async () => {} }
  const withoutRemove = new ProfilePluginExecutor(base)
  expect(() => { withoutRemove.validate(f.authority(), 'plugin', action({ action: 'remove' })) }).toThrow('upgrade_required')
  const disabledUpdate = new ProfilePluginExecutor({ ...base,
    togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [{ entryId: 'include:x', moduleName: 'x' }],
      expected: [], disabled: [] }) })
  expect(() => { disabledUpdate.validate(f.authority(), 'plugin',
    action({ action: 'update', spec: 'fixture@2.0.0' })) }).toThrow('plugin_update_requires_enabled')
})

it('rejects malformed removal evidence returned by the toggle planner', async () => {
  const f = fixture()
  writeFileSync(f.manifest, JSON.stringify({
    dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } },
  }))
  const executor = new ProfilePluginExecutor({
    resolve: () => f.root,
    uid: process.getuid!(),
    install: async () => {},
    acknowledge: async () => {},
    togglePlan: () => ({
      patch: '', expected: [], disabled: [], previousDisabled: [],
      previousExpected: [{ entryId: 'malformed', moduleName: 'fixture' }],
    }),
    acknowledgeToggle: async () => {},
    remove: async () => {},
    acknowledgeRemoval: async () => {},
  })
  await expect(executor.execute(f.authority(), JSON.stringify({ action: 'remove', packageName: 'fixture' }), {
    kind: 'plugin', signal: new AbortController().signal, guard() {},
  })).rejects.toThrow('invalid_package_intent')
})

it('rejects malformed bundle declarations and duplicate registrations before installation', () => {
  const f = fixture()
  for (const bundles of [{}, [7]]) {
    writeFileSync(f.manifest, JSON.stringify({ dsh: { profile: { bundles } } }), { mode: 0o600 })
    expect(() => { f.executor.validate(f.authority(), 'plugin', payload) }).toThrow('invalid_profile_manifest')
  }
  writeFileSync(f.manifest, JSON.stringify({ dsh: { profile: { bundles: ['fixture'] } } }), { mode: 0o600 })
  expect(() => { f.executor.validate(f.authority(), 'plugin', payload) }).toThrow('plugin_already_installed')
})
it('refuses a symlink manifest before installing without changing its target', () => {
  const f = fixture()
  const target = join(f.root, 'preserved-package.json')
  renameSync(f.manifest, target)
  symlinkSync(target, f.manifest)
  expect(() => { f.executor.validate(f.authority(), 'plugin', payload) })
    .toThrow(expect.objectContaining({ code: 'ELOOP' }))
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
it.each([
  ['missing dependency', { dependencies: {}, dsh: { profile: { bundles: ['fixture'] } } }, 'plugin_bundle_missing'],
  ['non-string dependency', { dependencies: { fixture: 1 }, dsh: { profile: { bundles: ['fixture'] } } }, 'plugin_target_changed'],
  ['non-array bundles', { dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: 'fixture' } } }, 'invalid_profile_manifest'],
  ['duplicate bundle registrations', { dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture', 'fixture'] } } }, 'plugin_target_changed'],
  ['missing bundle registration', { dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: [] } } }, 'plugin_bundle_missing'],
] as const)('rejects an install whose command leaves %s', async (_label, installed, reason) => {
  const f = fixture()
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => { writeFileSync(f.manifest, JSON.stringify(installed), { mode: 0o600 }) },
    acknowledge: async () => { throw Error('must not acknowledge malformed installation') },
  })
  await expect(executor.execute(f.authority(), payload,
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toThrow(reason)
})

it('rejects malformed package-completion receipts before inspecting Profile state', async () => {
  const f = fixture()
  for (const receipt of [
    {},
    { profileId: f.authority(), kind: 'skill' },
    { profileId: randomUUID(), kind: 'plugin' },
  ]) {
    await expect(f.executor.validatePluginCompletion(f.authority(), receipt as ExtensionReceipt)).rejects.toThrow('invalid_recovery')
  }
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

it('rejects an oversized original toggle patch before creating its recovery backup', async () => {
  const f = fixture(); const file = join(f.web, 'cordis.patch.yml')
  writeFileSync(file, 'x'.repeat(1_048_577), { mode: 0o600 })
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => {}, acknowledge: async () => {},
    togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }),
    acknowledgeToggle: async () => { throw Error('must not acknowledge an unbacked toggle') },
  })
  await expect(executor.execute(f.authority(), JSON.stringify({ action: 'toggle', packageName: 'fixture', enabled: false }),
    { kind: 'plugin', operationId: randomUUID(), checkpointPluginToggle() {}, signal: new AbortController().signal, guard() {} }))
    .rejects.toThrow('invalid_patch')
})

it.each(['oversized patch', 'revision drift', 'patch drift', 'revision result drift'] as const)(
  'rejects toggle publication with %s', async (mode) => {
    const f = fixture(); const file = join(f.web, 'cordis.patch.yml'); let plans = 0; let guards = 0
    writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
    const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
      install: async () => {}, acknowledge: async () => {},
      togglePlan: () => {
        plans++
        if (mode === 'revision drift' && plans === 2) writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'changed', { mode: 0o600 })
        return { patch: mode === 'oversized patch' ? 'x'.repeat(1_048_577) : 'next',
          previousExpected: [], previousDisabled: [], expected: [], disabled: [] }
      },
      acknowledgeToggle: async () => { throw Error('must not acknowledge an unpublished patch') },
    })
    if (mode === 'revision result drift') {
      const revision = executor.revision.bind(executor); let revisions = 0
      executor.revision = async profileId => ++revisions === 3 ? '0'.repeat(64) : revision(profileId)
    }
    await expect(executor.execute(f.authority(), JSON.stringify({ action: 'toggle', packageName: 'fixture', enabled: false }),
      { kind: 'plugin', signal: new AbortController().signal, guard() {
        guards++
        if (mode === 'patch drift' && guards === 3) writeFileSync(file, 'changed', { mode: 0o600 })
      } })).rejects.toThrow(mode === 'oversized patch' ? 'invalid_patch' : 'plugin_state_changed')
  })

it.each(['application', 'restoration'] as const)('rejects %s acknowledgement state drift after a toggle', async (mode) => {
  const f = fixture(); let acknowledgements = 0
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => {}, acknowledge: async () => {},
    togglePlan: () => ({ patch: 'next', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }),
    acknowledgeToggle: async () => {
      acknowledgements++
      if (mode === 'restoration' && acknowledgements === 1) throw Error('reload failed')
      writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'changed', { mode: 0o600 })
    },
  })
  await expect(executor.execute(f.authority(), JSON.stringify({ action: 'toggle', packageName: 'fixture', enabled: false }),
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toThrow('plugin_state_changed')
})

it.each(['toggle', 'remove'] as const)('retains an execution-layer capability guard for %s', async (action) => {
  const f = fixture()
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => {}, acknowledge: async () => {} })
  executor.validate = () => {}
  const request = action === 'toggle' ? { action, packageName: 'fixture', enabled: false } : { action, packageName: 'fixture' }
  await expect(executor.execute(f.authority(), JSON.stringify(request),
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toThrow('upgrade_required')
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
  writeFileSync(join(f.root, 'pnpm-workspace.yaml'), 'packages: []\n', { mode: 0o600 })
  writeFileSync(join(f.web, 'pnpm-workspace.yaml'), 'allowBuilds:\n  fixture: true\n  fixture@1.0.0: true\n  unrelated: false\n', { mode: 0o600 })
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

it('ignores target package policy entries that become empty after normalization', async () => {
  const f = fixture()
  writeFileSync(join(f.web, 'pnpm-workspace.yaml'),
    'allowBuilds:\n  fixture: true\nminimumReleaseAgeExclude:\n  - fixture\n  - fixture@1.0.0\n', { mode: 0o600 })
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(), install: async () => {},
    acknowledge: async () => {}, togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }),
    acknowledgeToggle: async () => {}, remove: async () => {
      writeFileSync(f.manifest, JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
    }, acknowledgeRemoval: async () => {} })
  await expect(executor.execute(f.authority(), JSON.stringify({ action: 'remove', packageName: 'fixture' }),
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })).resolves.toEqual({ state: 'succeeded' })
})

it.each(['null', 'fixture', '[]', 'minimumReleaseAgeExclude: fixture', 'minimumReleaseAgeExclude:\n  - fixture@1.0.0\n  - 7'])(
  'rejects a malformed plugin build policy (%s)', async (policy) => {
    const f = fixture()
    writeFileSync(join(f.web, 'pnpm-workspace.yaml'), `${policy}\n`, { mode: 0o600 })
    writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
    const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(), install: async () => {},
      acknowledge: async () => {}, togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }),
      acknowledgeToggle: async () => {}, remove: async () => {}, acknowledgeRemoval: async () => {} })
    await expect(executor.execute(f.authority(), JSON.stringify({ action: 'remove', packageName: 'fixture' }),
      { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toThrow('invalid_plugin_policy')
  })

it.each(['bundle remains', 'bundle metadata missing', 'acknowledgement drift'] as const)(
  'rejects an unconfirmed plugin removal when %s', async (mode) => {
    const f = fixture(); const file = join(f.web, 'cordis.patch.yml')
    writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
    const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
      install: async () => {}, acknowledge: async () => {},
      togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }), acknowledgeToggle: async () => {},
      remove: async () => { writeFileSync(f.manifest, JSON.stringify({ dependencies: {}, dsh: { profile:
        mode === 'bundle metadata missing' ? {} : { bundles: mode === 'bundle remains' ? ['fixture'] : [] } } })) },
      acknowledgeRemoval: async () => {
        if (mode === 'acknowledgement drift') writeFileSync(file, 'changed', { mode: 0o600 })
      },
    })
    await expect(executor.execute(f.authority(), JSON.stringify({ action: 'remove', packageName: 'fixture' }),
      { kind: 'plugin', signal: new AbortController().signal, guard() {} }))
      .rejects.toThrow(mode === 'acknowledgement drift' ? 'plugin_state_changed' : 'plugin_removal_unconfirmed')
  })

it('rejects a remove command that leaves the managed dependency installed', async () => {
  const f = fixture()
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => {}, acknowledge: async () => {},
    togglePlan: () => ({ patch: '', previousExpected: [], previousDisabled: [], expected: [], disabled: [] }), acknowledgeToggle: async () => {},
    remove: async () => {}, acknowledgeRemoval: async () => { throw Error('must not acknowledge an installed dependency') },
  })
  await expect(executor.execute(f.authority(), JSON.stringify({ action: 'remove', packageName: 'fixture' }),
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toThrow('plugin_removal_unconfirmed')
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
  const receipt = f.store.read(id)!
  await expect(executor.validatePluginRestore(randomUUID(), receipt)).rejects.toThrow('invalid_recovery')
  await expect(executor.validatePluginRestore(f.authority(), { ...receipt, kind: 'skill' })).rejects.toThrow('invalid_recovery')
  const withoutEvidence = { ...receipt }; delete withoutEvidence.pluginToggleRecovery
  await expect(executor.validatePluginRestore(f.authority(), withoutEvidence)).rejects.toThrow('invalid_recovery')
  await expect(executor.validatePluginRestore(f.authority(), { ...receipt, operationId: 'invalid' })).rejects.toThrow('invalid_input')
  const withoutToggle = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(), install: async () => {},
    acknowledge: async () => {} })
  await expect(withoutToggle.validatePluginRestore(f.authority(), receipt)).rejects.toThrow('upgrade_required')
  await expect(executor.validatePluginRestore(f.authority(), { ...receipt,
    pluginToggleRecovery: { ...receipt.pluginToggleRecovery!, beforeRevision: receipt.pluginToggleRecovery!.afterRevision } }))
    .rejects.toThrow('plugin_state_changed')
  if (original === '') {
    const drift = join(f.root, '.npmrc'); let guards = 0
    await expect(executor.restorePluginToggle(f.authority(), receipt,
      { kind: 'plugin', signal: new AbortController().signal, guard() {
        guards++
        if (guards === 2) writeFileSync(drift, 'changed', { mode: 0o600 })
      } })).rejects.toThrow('plugin_state_changed')
    unlinkSync(drift)
    const published = readFileSync(file, 'utf8')
    const driftingAcknowledgement = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
      install: async () => {}, acknowledge: async () => {},
      togglePlan: (_id, name, enabled, patch) => planPluginToggle(layers, patch, [], name, enabled),
      acknowledgeToggle: async () => { writeFileSync(drift, 'changed', { mode: 0o600 }) },
    })
    await expect(driftingAcknowledgement.restorePluginToggle(f.authority(), receipt,
      { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toThrow('plugin_state_changed')
    unlinkSync(drift); writeFileSync(file, published, { mode: 0o600 })
  }
  if (original === '# keep\n[]\n') {
    const drift = join(f.root, '.npmrc'); const published = readFileSync(file, 'utf8')
    const publishingDrift = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
      install: async () => {}, acknowledge: async () => {},
      togglePlan: (_id, name, enabled, patch) => planPluginToggle(layers, patch, [], name, enabled),
      acknowledgeToggle: async () => { throw Error('must not acknowledge an unstable restoration') },
    })
    const revision = publishingDrift.revision.bind(publishingDrift); let revisions = 0
    publishingDrift.revision = async (profileId) => {
      const value = await revision(profileId)
      if (++revisions === 2) writeFileSync(drift, 'changed', { mode: 0o600 })
      return value
    }
    await expect(publishingDrift.restorePluginToggle(f.authority(), receipt,
      { kind: 'plugin', signal: new AbortController().signal, guard() {} })).rejects.toThrow('plugin_state_changed')
    unlinkSync(drift); writeFileSync(file, published, { mode: 0o600 })
  }
  await operations.dispose(); operations = new ProfileExtensionOperations(f.store, executor, { now: Date.now })
  const restore = JSON.stringify({ action: 'restore-toggle', operationId: id })
  const backup = join(f.web, `.plugin-before-${id}`); const backupBytes = readFileSync(backup, 'utf8')
  writeFileSync(backup, 'invalid header')
  await expect(operations.prepare(f.authority, 'plugin', restore)).rejects.toThrow('invalid_backup')
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
  const receipt = f.store.read(id)!
  const completionContext = { kind: 'plugin' as const, signal: new AbortController().signal, guard() {} }
  if (action === 'install') {
    const validateCompletion = executor.validatePluginCompletion.bind(executor)
    executor.validatePluginCompletion = async () => {}
    const withoutEvidence = { ...receipt }; delete withoutEvidence.pluginPackage
    await expect(executor.completePluginPackage(f.authority(), withoutEvidence, completionContext)).rejects.toThrow('invalid_recovery')
    const withoutSpecEvidence = { ...receipt.pluginPackage! }; delete withoutSpecEvidence.spec
    const interrupted = readFileSync(f.manifest, 'utf8'); writeFileSync(f.manifest, JSON.stringify(before))
    await expect(executor.completePluginPackage(f.authority(),
      { ...receipt, pluginPackage: withoutSpecEvidence }, completionContext)).rejects.toThrow('invalid_package_intent')
    writeFileSync(f.manifest, interrupted)
    executor.validatePluginCompletion = validateCompletion
  }
  if (action === 'remove') {
    const withoutRepair = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
      install: async () => {}, acknowledge: async () => {}, remove: async () => {}, acknowledgeRemoval: async () => {} })
    await expect(withoutRepair.validatePluginCompletion(f.authority(), receipt)).rejects.toThrow('upgrade_required')
    const withoutRemove = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
      install: async () => {}, acknowledge: async () => {}, repair: async () => {}, acknowledgeRemoval: async () => {} })
    withoutRemove.validatePluginCompletion = async () => {}
    await expect(withoutRemove.completePluginPackage(f.authority(), receipt, completionContext)).rejects.toThrow('upgrade_required')
    withoutRepair.validatePluginCompletion = async () => {}
    await expect(withoutRepair.completePluginPackage(f.authority(), receipt, completionContext)).rejects.toThrow('upgrade_required')
  }
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

it('normalizes non-local package scope and unordered metadata without changing it', async () => {
  const f = fixture(); const rootManifest = join(f.root, 'package.json')
  writeFileSync(rootManifest, JSON.stringify({ a: true, z: { a: 2, b: 1 } }), { mode: 0o600 })
  writeFileSync(f.manifest, JSON.stringify({ dsh: { profile: {} } }), { mode: 0o600 })
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => { writeFileSync(f.manifest,
      JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } })) },
    acknowledge: async () => {},
  })
  await expect(executor.execute(f.authority(), payload,
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })).resolves.toEqual({ state: 'succeeded' })
  expect(JSON.parse(readFileSync(rootManifest, 'utf8'))).toEqual({ a: true, z: { a: 2, b: 1 } })
})

it('allows the package runner to update the target minimum-release-age exception', async () => {
  const f = fixture(); const workspace = join(f.web, 'pnpm-workspace.yaml')
  writeFileSync(workspace, 'packages:\n  - .\nminimumReleaseAgeExclude:\n  - keep@1.0.0\n', { mode: 0o600 })
  const executor = new ProfilePluginExecutor({ resolve: () => f.root, uid: process.getuid!(),
    install: async () => {
      writeFileSync(f.manifest, JSON.stringify({ dependencies: { fixture: '1.0.0' }, dsh: { profile: { bundles: ['fixture'] } } }))
      writeFileSync(workspace, 'minimumReleaseAgeExclude:\n  - keep@1.0.0\n  - fixture@1.0.0\npackages:\n  - .\n')
    }, acknowledge: async () => {},
  })
  await expect(executor.execute(f.authority(), payload,
    { kind: 'plugin', signal: new AbortController().signal, guard() {} })).resolves.toEqual({ state: 'succeeded' })
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
