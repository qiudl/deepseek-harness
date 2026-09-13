import AdmZip from 'adm-zip'
import { parseSkillFile } from '#hub-skills'
import { createHash, randomUUID } from 'node:crypto'
import { FileExtensionReceipts, ProfileExtensionOperations } from '../src/extension-operations.ts'
import type {} from '@deepseek-ai/dsh-skill'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ProfileSkillExecutor } from '../src/profile-skill-executor.ts'
const payload = JSON.stringify({ name: 'host-demo', description: 'Profile-local test', body: 'Use the profile fixture.', modelInvocable: true, userInvocable: false })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hskill-')))
  mkdirSync(join(root, 'a'), { mode: 0o700 }); mkdirSync(join(root, 'b'), { mode: 0o700 })
  onTestFinished(() =>{  rmSync(root, { recursive: true, force: true }) })
  return root
}
it('refuses a new skill at capacity while keeping existing skills manageable', async () => {
  const root = fixture()
  const skills = join(root, 'a/skills')
  mkdirSync(skills, { mode: 0o700 })
  for (let i = 0; i < 128; i++) {
    writeFileSync(join(skills, `skill-${i}.md`), `---\nname: skill-${i}\ndescription: Existing skill\n---\nKeep this skill.\n`, { mode: 0o600 })
  }
  const acknowledge = vi.fn(async () => undefined)
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge })
  expect(await executor.inventory('a')).toHaveLength(128)
  await expect(executor.execute('a', payload, { kind: 'skill', signal: new AbortController().signal, guard() {} })).rejects.toThrow('skill_limit')
  expect(acknowledge).not.toHaveBeenCalled()
  expect(readdirSync(skills)).toHaveLength(128)
  expect(() => executor.validate('a', 'skill', JSON.stringify({ action: 'remove', id: 'flat-skill-0' }))).not.toThrow()
})
it('uses Hub Markdown serialization, writes only the authorized Profile and waits for acknowledgement', async () => {
  const root = fixture(); const calls: string[] = []
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id),
    acknowledge: async (id, name, content, signal, guard) => {
      guard(); expect(signal.aborted).toBe(false); expect(id).toBe('a'); expect(name).toBe('host-demo')
      expect(readFileSync(join(root, 'a/skills/host-demo/SKILL.md'), 'utf8')).toBe(content)
      expect(content).toContain('user-invocable: false'); calls.push('ack')
      return { name, description: 'Profile-local test', content: 'Use the profile fixture.',
        path: join(root, id, 'skills', name, 'SKILL.md'), source: 'user-dsh', invocation: { modelInvocable: true, userInvocable: false } }
    } })
  const before = await executor.revision('a'); const other = await executor.revision('b')
  expect(await executor.execute('a', payload, { kind: 'skill', signal: new AbortController().signal, guard() {} })).toEqual({ state: 'succeeded' })
  expect(calls).toEqual(['ack']); expect(await executor.revision('a')).not.toBe(before); expect(await executor.revision('b')).toBe(other)
  expect(() =>{  executor.validate('a', 'skill', payload) }).toThrow()
})
it('rejects traversal, unsupported metadata, symlink roots and existing flat skills without overwriting', () => {
  const root = fixture()
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge: async () => {} })
  for (const bad of [{ name: '../escape' }, { extra: 'unsupported' }]) expect(() =>{  executor.validate('a', 'skill', JSON.stringify({ ...JSON.parse(payload), ...bad })) }).toThrow()
  symlinkSync(join(root, 'b'), join(root, 'a/skills'))
  expect(() =>{  executor.validate('a', 'skill', payload) }).toThrow()
  mkdirSync(join(root, 'b/skills'), { mode: 0o700 }); writeFileSync(join(root, 'b/skills/host-demo.md'), 'original', { mode: 0o600 })
  expect(() =>{  executor.validate('b', 'skill', payload) }).toThrow()
  expect(readFileSync(join(root, 'b/skills/host-demo.md'), 'utf8')).toBe('original')
})
it('never reports success on acknowledgement failure or cancellation before publication', async () => {
  const root = fixture()
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge: async () => { throw Error('unverified runtime') } })
  await expect(executor.execute('a', payload, { kind: 'skill', signal: AbortSignal.abort(), guard() {} })).rejects.toThrow()
  expect(await executor.revision('a')).toBe(await executor.revision('b'))
  await expect(executor.execute('a', payload, { kind: 'skill', signal: new AbortController().signal, guard() {} })).rejects.toThrow('unverified runtime')
  expect(readFileSync(join(root, 'a/skills/host-demo/SKILL.md'), 'utf8')).toContain('Use the profile fixture.')
})

it('loads the installed Markdown through the real Cordis Loader and filesystem skill provider', async () => {
  const { boot } = await import('@deepseek-ai/dsh-app-boot')
  const root = fixture()
  let loaded: import('@deepseek-ai/cordis').Context | undefined
  onTestFinished(async () => { await loaded?.fiber.dispose() })
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id),
    acknowledge: async (id, name, _content, signal, guard) => {
      guard()
      const config = join(root, id, 'cordis.yml')
      writeFileSync(config, JSON.stringify([
        { id: 'skill-registry', name: '@deepseek-ai/dsh-skill' },
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem',
          config: { dshHome: join(root, id), agentsHome: join(root, 'isolated-agents'), watch: false } },
      ]))
      await loaded?.fiber.dispose()
      loaded = await boot('host-skill-test', config, [], undefined, new URL('../../../../apps/cli/', import.meta.url).href)
      const actual = await loaded.skills.get(name, { signal })
      expect(actual?.source).toBe('user-dsh')
      expect(actual?.path).toBe(join(root, id, 'skills', name, 'SKILL.md'))
      expect(actual?.content).toBe('Use the profile fixture.')
      expect(actual?.invocation).toBeDefined()
      guard()
      return actual
    } })
  expect(await executor.execute('a', payload, { kind: 'skill', signal: new AbortController().signal, guard() {} }))
    .toEqual({ state: 'succeeded' })
  const flags = (kind: 'model' | 'user', value: boolean) => JSON.stringify({ action: 'invocation', id: 'bundle-host-demo', kind, value })
  await executor.execute('a', flags('model', false), { kind: 'skill', signal: new AbortController().signal, guard() {} })
  expect((await loaded?.skills.get('host-demo'))?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  await executor.execute('a', flags('user', true), { kind: 'skill', signal: new AbortController().signal, guard() {} })
  expect((await loaded?.skills.get('host-demo'))?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
})

it('persists an unknown skill receipt after unverified publication and never repeats its write', async () => {
  const root = fixture(); const uid = process.getuid!(); const profileId = randomUUID(); let acknowledgements = 0
  const executor = new ProfileSkillExecutor({ uid, profileRoot: () => join(root, 'a'), acknowledge: async () => {
    acknowledgements++; throw Error('unverified runtime')
  } })
  const receipts = new FileExtensionReceipts(join(root, 'receipts'), uid)
  const owner = new ProfileExtensionOperations(receipts, executor, { now: () => Date.now() })
  onTestFinished(async () => { await owner.dispose() })
  const authority = () => profileId
  const plan = await owner.prepare(authority, 'skill', payload); const operationId = randomUUID()
  owner.commit(authority, plan.planId, operationId)
  await owner.settled()
  expect(owner.status(authority, operationId).state).toBe('unknown')
  expect(owner.commit(authority, plan.planId, operationId).state).toBe('unknown')
  expect(acknowledgements).toBe(1)
  expect(JSON.stringify(receipts.read(operationId))).not.toContain('Use the profile fixture.')
  const next = await owner.prepare(authority, 'skill', JSON.stringify({ ...JSON.parse(payload), name: 'another-skill' }))
  expect(() => { owner.commit(authority, next.planId, randomUUID()) }).toThrow('busy')
})

it('preserves a competing SKILL.md instead of overwriting it during publication', async () => {
  const root = fixture(); let guards = 0
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge: async () => {} })
  await expect(executor.execute('a', payload, { kind: 'skill', signal: new AbortController().signal, guard() {
    if (++guards === 3) writeFileSync(join(root, 'a/skills/host-demo/SKILL.md'), 'concurrent author', { mode: 0o600 })
  } })).rejects.toThrow('skill_changed')
  expect(readFileSync(join(root, 'a/skills/host-demo/SKILL.md'), 'utf8')).toBe('concurrent author')
})

it('keeps an unknown receipt when the acknowledgement returns without an observed definition', async () => {
  const root = fixture(); const profileId = randomUUID()
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: () => join(root, 'a'), acknowledge: async () => {} })
  const owner = new ProfileExtensionOperations(new FileExtensionReceipts(join(root, 'receipts'), process.getuid!()), executor, { now: () => Date.now() })
  onTestFinished(async () => { await owner.dispose() })
  const authority = () => profileId
  const plan = await owner.prepare(authority, 'skill', payload); const operationId = randomUUID()
  owner.commit(authority, plan.planId, operationId)
  await owner.settled()
  expect(owner.status(authority, operationId).state).toBe('unknown')
})

it('publishes the exact confirmed GitHub bundle with scripts and attachments, and revisions include resources', async () => {
  const root = fixture(); const archive = new AdmZip()
  const markdown = '---\nname: host-demo\ndescription: Archive test\nlicense: MIT\n---\nUse scripts/run.sh.\n'
  archive.addFile('repo-main/demo/SKILL.md', Buffer.from(markdown))
  archive.addFile('repo-main/demo/scripts/run.sh', Buffer.from('echo demo'), '', 0o100700 << 16 >>> 0)
  archive.addFile('repo-main/demo/references/guide.md', Buffer.from('Original guide'))
  const data = archive.toBuffer()
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(data))); onTestFinished(() => { vi.unstubAllGlobals() })
  const input = JSON.stringify({ name: 'host-demo', archive: { url: 'https://codeload.github.com/fixture/repo/zip/refs/heads/main',
    subPath: 'demo', sha256: createHash('sha256').update(data).digest('hex') } })
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge: async () => ({
    name: 'host-demo', description: 'Archive test', content: 'Use scripts/run.sh.', source: 'user-dsh',
    path: join(root, 'a/skills/host-demo/SKILL.md'), invocation: { modelInvocable: true, userInvocable: true },
  }) })
  await expect(executor.execute('a', input, { kind: 'skill', signal: new AbortController().signal, guard() {} })).resolves.toEqual({ state: 'succeeded' })
  expect(readFileSync(join(root, 'a/skills/host-demo/SKILL.md'), 'utf8')).toBe(markdown)
  expect(readFileSync(join(root, 'a/skills/host-demo/scripts/run.sh'), 'utf8')).toBe('echo demo')
  const before = await executor.revision('a')
  writeFileSync(join(root, 'a/skills/host-demo/references/guide.md'), 'Changed guide')
  expect(await executor.revision('a')).not.toBe(before)
  const changed = JSON.stringify({ name: 'changed', archive: { url: 'https://codeload.github.com/fixture/repo/zip/refs/heads/main', subPath: 'demo', sha256: '0'.repeat(64) } })
  await expect(executor.execute('b', changed, { kind: 'skill', signal: new AbortController().signal, guard() {} })).rejects.toThrow('archive_changed')
  expect(await executor.inventory('b')).toEqual([])
})

it('changes one invocation field without losing metadata or resources and compensates failed acknowledgement', async () => {
  const root = fixture(); const directory = join(root, 'a/skills/host-demo')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'SKILL.md')
  const original = '---\nname: host-demo\ndescription: Test\ncustom: keep # metadata comment\n---\nBody stays exactly.\n'
  writeFileSync(file, original, { mode: 0o600 }); writeFileSync(join(directory, 'data.txt'), 'resource', { mode: 0o600 })
  let fail = true
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id),
    acknowledge: async (_id, name, content) => {
      if (fail) { fail = false; throw Error('reload failed') }
      const parsed = parseSkillFile(content)
      return { name, description: parsed.meta.description, content: parsed.body.trim(), path: file, source: 'user-dsh',
        invocation: { modelInvocable: parsed.meta['disable-model-invocation'] !== true, userInvocable: parsed.meta['user-invocable'] !== false } }
    } })
  const change = JSON.stringify({ action: 'invocation', id: 'bundle-host-demo', kind: 'model', value: false })
  const context = { kind: 'skill' as const, signal: new AbortController().signal, guard() {} }
  expect(await executor.execute('a', change, context)).toEqual({ state: 'failed' })
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(await executor.execute('a', change, context)).toEqual({ state: 'succeeded' })
  expect(readFileSync(file, 'utf8')).toContain('custom: keep # metadata comment')
  expect(readFileSync(file, 'utf8')).toContain('---\nBody stays exactly.\n')
  expect(readFileSync(join(directory, 'data.txt'), 'utf8')).toBe('resource')
  expect(await executor.inventory('a')).toMatchObject([{ model_invocable: false, user_invocable: true }])
  for (const bad of [{ action: 'invocation', id: '../escape', kind: 'model', value: true },
    { action: 'invocation', id: 'bundle-host-demo', kind: 'model', value: 'true' },
    { action: 'invocation', id: 'bundle-missing', kind: 'model', value: true }]) {
    expect(() => { executor.validate('a', 'skill', JSON.stringify(bad)) }).toThrow()
  }
})

it('imports original Markdown metadata and body without re-rendering it', async () => {
  const root = fixture()
  const markdown = '---\nname: imported\ndescription: Imported skill\nlicense: MIT # retain\ndisable-model-invocation: true\n---\nOriginal body.\n'
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id),
    acknowledge: async (id, name, content) => {
      expect(content).toBe(markdown)
      return { name, description: 'Imported skill', content: 'Original body.', source: 'user-dsh',
        path: join(root, id, 'skills', name, 'SKILL.md'), invocation: { modelInvocable: false, userInvocable: true } }
    } })
  const payload = JSON.stringify({ name: 'imported', markdown })
  expect(await executor.execute('a', payload, { kind: 'skill', signal: new AbortController().signal, guard() {} }))
    .toEqual({ state: 'succeeded' })
  expect(readFileSync(join(root, 'a/skills/imported/SKILL.md'), 'utf8')).toBe(markdown)
  expect(() => { executor.validate('a', 'skill', payload) }).toThrow('skill_exists')
  for (const invalid of [{ name: 'other', markdown }, { name: 'imported', markdown: 'No frontmatter' },
    { name: 'imported', markdown: markdown.replace('true', 'maybe') }, { name: 'imported', markdown, path: '/tmp' }]) {
    expect(() => { executor.validate('b', 'skill', JSON.stringify(invalid)) }).toThrow()
  }
})

it('replaces only the selected same-name Markdown, retains attachments, and restores an unacknowledged update', async () => {
  const root = fixture(); const directory = join(root, 'a/skills/host-demo')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'SKILL.md')
  const original = '---\nname: host-demo\ndescription: Original\n---\nOriginal body.\n'
  const markdown = '---\nname: host-demo\ndescription: Updated\nlicense: MIT # keep\nuser-invocable: false\n---\nUpdated body.\n'
  writeFileSync(file, original, { mode: 0o600 })
  writeFileSync(join(directory, 'reference.txt'), 'attachment', { mode: 0o600 })
  writeFileSync(join(root, 'a/skills/host-demo.md'), original, { mode: 0o600 })
  let rejectUpdate = true
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id),
    acknowledge: async (_id, name, content) => {
      if (rejectUpdate && content === markdown) { rejectUpdate = false; throw Error('reload failed') }
      const parsed = parseSkillFile(content)
      return { name, description: parsed.meta.description, content: parsed.body.trim(), path: file, source: 'user-dsh',
        invocation: { modelInvocable: true, userInvocable: parsed.meta['user-invocable'] !== false } }
    } })
  const change = { action: 'replace', id: 'bundle-host-demo', markdown }
  const context = { kind: 'skill' as const, signal: new AbortController().signal, guard() {} }
  expect(await executor.execute('a', JSON.stringify(change), context)).toEqual({ state: 'failed' })
  expect(readFileSync(file, 'utf8')).toBe(original)
  expect(await executor.execute('a', JSON.stringify(change), context)).toEqual({ state: 'succeeded' })
  expect(readFileSync(file, 'utf8')).toBe(markdown)
  expect(readFileSync(join(directory, 'reference.txt'), 'utf8')).toBe('attachment')
  expect(readFileSync(join(root, 'a/skills/host-demo.md'), 'utf8')).toBe(original)
  for (const invalid of [{ ...change, id: 'bundle-missing' }, { ...change, markdown: markdown.replace('name: host-demo', 'name: other') },
    { ...change, path: '/tmp/escape' }, { ...change, markdown: 'No frontmatter' }, { ...change, id: '../escape' }]) {
    expect(() => { executor.validate('a', 'skill', JSON.stringify(invalid)) }).toThrow()
  }
})

it.each(['absent', 'user-agents'] as const)('removes a bundle after observing %s and retains a durable source receipt', async (source) => {
  const root = fixture(); const directory = join(root, 'a/skills/host-demo')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: host-demo\ndescription: Original\n---\nOriginal body.\n', { mode: 0o600 })
  writeFileSync(join(directory, 'reference.txt'), 'attachment', { mode: 0o600 })
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: () => join(root, 'a'),
    acknowledge: async () => source === 'absent' ? null : {
      name: 'host-demo', description: 'Fallback', content: 'Fallback instructions.', source,
      path: join(root, 'agents/skills/host-demo/SKILL.md'), invocation: { modelInvocable: true, userInvocable: true },
    } })
  const profileId = randomUUID(); const authority = () => profileId
  const store = new FileExtensionReceipts(join(root, 'receipts'), process.getuid!())
  const owner = new ProfileExtensionOperations(store, executor, { now: () => Date.now() })
  onTestFinished(async () => { await owner.dispose() })
  const plan = await owner.prepare(authority, 'skill', JSON.stringify({ action: 'remove', id: 'bundle-host-demo' }))
  const operationId = randomUUID(); owner.commit(authority, plan.planId, operationId); await owner.settled()
  expect(owner.status(authority, operationId)).toMatchObject({ state: 'succeeded', skillSource: source })
  expect(await executor.inventory('a')).toEqual([])
  expect(store.read(operationId)).toMatchObject({ skillSource: source, skillRemoval: { entryId: 'bundle-host-demo', stage: 'removal_verified' } })
  expect(JSON.stringify(store.read(operationId))).not.toContain('Fallback instructions')
})

it('restores the complete removed bundle when runtime removal cannot be confirmed', async () => {
  const root = fixture(); const directory = join(root, 'a/skills/host-demo')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, 'SKILL.md'); const original = '---\nname: host-demo\ndescription: Original\n---\nOriginal body.\n'
  writeFileSync(file, original, { mode: 0o600 }); writeFileSync(join(directory, 'reference.txt'), 'attachment', { mode: 0o600 })
  let calls = 0
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge: async () => {
    calls++
    if (calls === 1) throw Error('reload unavailable')
    return { name:'host-demo',description:'Original',content:'Original body.',source:'user-dsh',path:file,
      invocation:{ modelInvocable:true,userInvocable:true } }
  } })
  expect(await executor.execute('a', JSON.stringify({ action:'remove',id:'bundle-host-demo' }),
    { kind:'skill',signal:new AbortController().signal,guard(){} })).toEqual({ state:'failed' })
  expect(readFileSync(file,'utf8')).toBe(original)
  expect(readFileSync(join(directory,'reference.txt'),'utf8')).toBe('attachment')
  expect(calls).toBe(2)
})

it('does not overwrite a concurrent replacement while restoring an unconfirmed Skill removal', async () => {
  const root = fixture(); const directory = join(root, 'a/skills')
  mkdirSync(directory, { mode: 0o700 })
  const file = join(directory, 'host-demo.md')
  const original = '---\nname: host-demo\ndescription: Original\n---\nOriginal body.\n'
  writeFileSync(file, original, { mode: 0o600 })
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge: async () => {
    writeFileSync(file, original.replace('Original body.', 'Concurrent author.'), { mode: 0o600 })
    throw Error('reload failed')
  } })
  await expect(executor.execute('a', JSON.stringify({ action:'remove',id:'flat-host-demo' }),
    { kind:'skill',signal:new AbortController().signal,guard(){} })).rejects.toThrow('skill_changed')
  expect(readFileSync(file,'utf8')).toContain('Concurrent author.')
  const retained = readdirSync(join(root,'a')).find(name => name.startsWith('.skill-removed-'))
  expect(retained).toBeDefined()
  expect(readFileSync(join(root,'a',retained!),'utf8')).toBe(original)
})

it('rejects local changes during a catalog read and propagates incomplete observations', async () => {
  const root = fixture()
  const catalog = vi.fn(async () => ({ complete: false, skills: [] }))
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id),
    catalog, acknowledge: async () => {} })
  await expect(executor.inventory('a')).rejects.toThrow('skill_catalog_unavailable')
  catalog.mockImplementation(async () => {
    mkdirSync(join(root, 'a/skills'), { mode: 0o700 })
    writeFileSync(join(root, 'a/skills/demo.md'), '---\nname: demo\ndescription: Demo\n---\nBody', { mode: 0o600 })
    return { complete: true, skills: [] }
  })
  await expect(executor.inventory('a')).rejects.toThrow('revision_conflict')
})

it('retains operation-owned removal evidence and attachment bytes across owner restart after cancellation', async () => {
  const root = fixture(); const directory = join(root, 'a/skills/host-demo')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const markdown = '---\nname: host-demo\ndescription: Original\n---\nPrivate instructions.\n'
  writeFileSync(join(directory, 'SKILL.md'), markdown, { mode: 0o600 })
  writeFileSync(join(directory, 'reference.txt'), 'private resource', { mode: 0o600 })
  const store = new FileExtensionReceipts(join(root, 'receipts'), process.getuid!())
  const profileId = randomUUID(); const operationId = randomUUID(); const controller = new AbortController()
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: () => join(root, 'a'), acknowledge: async () => {
    expect(store.read(operationId)?.skillRemoval).toMatchObject({ entryId:'bundle-host-demo',stage:'removed' })
    expect(readFileSync(join(root, 'a', `.skill-removed-${operationId}`, 'reference.txt'), 'utf8')).toBe('private resource')
    controller.abort(); throw Error('interrupted')
  } })
  const before = await executor.revision(profileId)
  const owner = new ProfileExtensionOperations(store, executor, { now: () => Date.now() })
  onTestFinished(async () => { await owner.dispose() })
  const plan = await owner.prepare(() => profileId, 'skill', JSON.stringify({ action:'remove',id:'bundle-host-demo' }))
  owner.commit(() => profileId, plan.planId, operationId, controller.signal); await owner.settled(); await owner.dispose()
  const recovered = new ProfileExtensionOperations(new FileExtensionReceipts(join(root, 'receipts'), process.getuid!()), executor, { now:()=>Date.now() })
  onTestFinished(async () => { await recovered.dispose() })
  const receipt = recovered.status(() => profileId, operationId)
  expect(receipt).toMatchObject({ state:'unknown',skillRemoval:{ entryId:'bundle-host-demo',stage:'removed',beforeRevision:before,removedRevision:await executor.revision(profileId) } })
  expect(JSON.stringify(receipt)).not.toContain('Private instructions')
  expect(JSON.stringify(receipt)).not.toContain(root)
  expect(readFileSync(join(root, 'a', `.skill-removed-${operationId}`, 'SKILL.md'), 'utf8')).toBe(markdown)
  expect(() => recovered.status(() => randomUUID(), operationId)).toThrow('unauthorized')
})

it('does not move a Skill when its checkpoint cannot persist or its operation backup already exists', async () => {
  const root = fixture(); const directory = join(root, 'a/skills')
  mkdirSync(directory, { mode: 0o700 })
  const file = join(directory, 'host-demo.md'); const markdown = '---\nname: host-demo\ndescription: Original\n---\nBody.\n'
  writeFileSync(file, markdown, { mode: 0o600 })
  const operationId = randomUUID()
  const executor = new ProfileSkillExecutor({ uid: process.getuid!(), profileRoot: id => join(root, id), acknowledge: async () => null })
  const context = { kind:'skill' as const, operationId, signal:new AbortController().signal, guard() {},
    checkpointSkillRemoval() { throw Error('disk unavailable') } }
  await expect(executor.execute('a', JSON.stringify({ action:'remove',id:'flat-host-demo' }), context)).rejects.toThrow('disk unavailable')
  expect(readFileSync(file, 'utf8')).toBe(markdown)
  const backup = join(root, 'a', `.skill-removed-${operationId}`)
  writeFileSync(backup, 'old evidence', { mode:0o600 })
  await expect(executor.execute('a', JSON.stringify({ action:'remove',id:'flat-host-demo' }), context)).rejects.toThrow('skill_backup_exists')
  expect(readFileSync(backup, 'utf8')).toBe('old evidence')
  expect(readFileSync(file, 'utf8')).toBe(markdown)
})

it('restores an operation-owned Skill backup after a confirmed recovery and acknowledges its definition', async () => {
  const root = fixture(); const directory = join(root, 'a/skills')
  mkdirSync(directory, { mode:0o700 })
  const file = join(directory,'host-demo.md'); const markdown='---\nname: host-demo\ndescription: Original\n---\nOriginal body.\n'
  writeFileSync(file,markdown,{ mode:0o600 })
  const store=new FileExtensionReceipts(join(root,'receipts'),process.getuid!());const profileId=randomUUID();const originalId=randomUUID()
  let interrupt=true; let verifyFailure=false;const controller=new AbortController()
  const executor=new ProfileSkillExecutor({ uid:process.getuid!(),profileRoot:()=>join(root,'a'),acknowledge:async()=>{
    if(interrupt){controller.abort();throw Error('interrupted')}
    if(verifyFailure) throw Error('runtime unavailable')
    return { name:'host-demo',description:'Original',content:'Original body.',source:'user-dsh',path:file,invocation:{ modelInvocable:true,userInvocable:true } }
  } })
  const owner=new ProfileExtensionOperations(store,executor,{ now:()=>Date.now() });onTestFinished(async()=>{await owner.dispose()})
  const plan=await owner.prepare(()=>profileId,'skill',JSON.stringify({ action:'remove',id:'flat-host-demo' }))
  owner.commit(()=>profileId,plan.planId,originalId,controller.signal);await owner.settled()
  expect(owner.status(()=>profileId,originalId).state).toBe('unknown');interrupt=false
  writeFileSync(file, 'Concurrent author', { mode: 0o600 })
  await expect(owner.prepare(() => profileId, 'skill', JSON.stringify({ action: 'restore-removal', operationId: originalId })))
    .rejects.toThrow('recovery_conflict')
  expect(readFileSync(file, 'utf8')).toBe('Concurrent author')
  rmSync(file)
  const recovery=await owner.prepare(()=>profileId,'skill',JSON.stringify({ action:'restore-removal',operationId:originalId }))
  verifyFailure=true
  const firstRecoveryId=randomUUID();owner.commit(()=>profileId,recovery.planId,firstRecoveryId);await owner.settled()
  expect(owner.status(()=>profileId,firstRecoveryId).state).toBe('unknown')
  expect(readFileSync(file,'utf8')).toBe(markdown)
  verifyFailure=false
  const retry=await owner.prepare(()=>profileId,'skill',JSON.stringify({ action:'restore-removal',operationId:originalId }))
  const recoveryId=randomUUID();owner.commit(()=>profileId,retry.planId,recoveryId);await owner.settled()
  expect(owner.status(()=>profileId,recoveryId)).toMatchObject({ state:'succeeded',restores:originalId })
  expect(readFileSync(file,'utf8')).toBe(markdown)
  expect(owner.status(()=>profileId,originalId)).toMatchObject({ state:'unknown',restoredBy:recoveryId })
  expect(owner.status(()=>profileId,firstRecoveryId)).toMatchObject({ state:'unknown',restoredBy:recoveryId })
  const next=await owner.prepare(()=>profileId,'skill',JSON.stringify({ action:'remove',id:'flat-host-demo' }))
  expect(owner.commit(()=>profileId,next.planId,randomUUID()).state).toBe('queued')
  await owner.settled()
  await owner.dispose()
  const restarted=new ProfileExtensionOperations(store,executor,{ now:()=>Date.now() })
  expect(restarted.status(()=>profileId,originalId)).toMatchObject({ state:'unknown',restoredBy:recoveryId })
  await restarted.dispose()
})
