/** REQ-20261013-0021 / 24205. Host facts, never the Server's project-install projection. */
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, expect, it } from 'vitest'
import { createSkillHubPackageInstallationStore, createSkillHubPackageStoreFactory } from '../src/skillhub-package-install.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const profileId = '11111111-1111-4111-8111-111111111111'
const hostKeyId = 'a'.repeat(64)
const packageId = 'package-1'
const markdown = Buffer.from('---\nname: example\ndescription: Example\nversion: 1.0.0\n---\n# Example\n')
const resource = Buffer.from('complete-resource\n')

function archive(resourceBytes = resource) {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', markdown)
  zip.addFile('references/data.txt', resourceBytes)
  const bytes = zip.toBuffer()
  const files = [
    ['SKILL.md', '0644', markdown.length, sha(markdown)],
    ['references/data.txt', '0644', resourceBytes.length, sha(resourceBytes)],
  ]
  return { bytes, archiveSha256: sha(bytes), manifestSha256: sha(JSON.stringify([
    'slark-skillhub-manifest-v1', files,
  ])) }
}
function target(versionId: string, evidence: ReturnType<typeof archive>, operationId = randomUUID()) {
  return {
    operationId, packageId, profileId, hostKeyId, bindingGeneration: '1', expectedRevision: '0',
    versionId, skillSlug: 'example', version: '1.0.0',
    archiveSha256: evidence.archiveSha256, manifestSha256: evidence.manifestSha256,
  }
}
async function store() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skillhub-package-'))
  roots.push(root)
  return { root, installation: await createSkillHubPackageInstallationStore(root, profileId, hostKeyId, '1') }
}

it('retains the old complete package when a truncated or changed archive is prepared', async () => {
  const { installation } = await store()
  const first = archive()
  const plan = target('version-1', first)
  await installation.prepare(plan, first.bytes)
  const receipt = await installation.activate(plan.operationId, '1', '0')
  expect(receipt).toMatchObject({ operationId: plan.operationId, profileId, hostKeyId,
    bindingGeneration: '1', revision: '1', versionId: 'version-1', readiness: 'prepared' })
  expect(await installation.readFile(packageId, 'references/data.txt')).toEqual(resource)

  const next = archive(Buffer.from('replacement\n'))
  const nextPlan = { ...target('version-2', next), expectedRevision: '1' }
  await expect(installation.prepare(nextPlan, next.bytes.subarray(0, next.bytes.length - 5))).rejects.toThrow()
  await expect(installation.prepare(nextPlan, first.bytes)).rejects.toThrow()
  expect(await installation.current(packageId)).toEqual(receipt)
  expect(await installation.readFile(packageId, 'references/data.txt')).toEqual(resource)
})

it('pins every file to the admitted version while a later version activates', async () => {
  const { root, installation } = await store()
  const first = archive()
  const prior = target('version-1', first)
  await installation.prepare(prior, first.bytes)
  await installation.activate(prior.operationId, '1', '0')
  const fixed = await installation.snapshot(packageId)
  expect(fixed.receipt.operationId).toBe(prior.operationId)
  expect(fixed.files).toEqual([
    { path: 'SKILL.md', mode: '0644', size: markdown.length, sha256: sha(markdown) },
    { path: 'references/data.txt', mode: '0644', size: resource.length, sha256: sha(resource) },
  ])
  expect(await fixed.readFile('SKILL.md')).toEqual(markdown)

  const replacement = Buffer.from('replacement\n')
  const next = archive(replacement)
  const later = { ...target('version-2', next), expectedRevision: '1' }
  await installation.prepare(later, next.bytes)
  await installation.activate(later.operationId, '1', '1')
  expect(await installation.readFile(packageId, 'references/data.txt')).toEqual(replacement)
  expect(await fixed.readFile('references/data.txt')).toEqual(resource)
  const reopened = await installation.snapshotFixed(fixed.receipt)
  expect(reopened.files).toEqual(fixed.files)
  expect(await reopened.readFile('references/data.txt')).toEqual(resource)
  await expect(installation.snapshotFixed({ ...fixed.receipt,
    manifestSha256: 'b'.repeat(64) })).rejects.toThrow()
  await expect(fixed.readFile('../SKILL.md')).rejects.toThrow()
  writeFileSync(join(root, 'skillhub-versions', prior.operationId,
    'files', 'references', 'data.txt'), 'tampered\n')
  await expect(fixed.readFile('references/data.txt')).rejects.toThrow()
})

it('refuses a missing pointer or changed fixed plan after a snapshot was captured', async () => {
  const { root, installation } = await store()
  await expect(installation.snapshot(packageId)).rejects.toThrow()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  await installation.activate(plan.operationId, '1', '0')
  const fixed = await installation.snapshot(packageId)
  const path = join(root, 'skillhub-versions', plan.operationId, 'plan.json')
  unlinkSync(path)
  await expect(fixed.readFile('SKILL.md')).rejects.toThrow()
  writeFileSync(path, JSON.stringify({ ...plan, versionId: 'forged' }))
  await expect(fixed.readFile('SKILL.md')).rejects.toThrow()
  writeFileSync(path, JSON.stringify(plan))
  expect(await fixed.readFile('SKILL.md')).toEqual(markdown)
})

it('reads only the requested file after a complete fixed snapshot check', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  const receipt = await installation.activate(plan.operationId, '1', '0')
  const fixed = await installation.snapshotFixed(receipt)
  const base = join(root, 'skillhub-versions', plan.operationId)
  const unrelated = join(base, 'files', 'references', 'data.txt')
  writeFileSync(unrelated, 'corrupted')
  expect(await fixed.readFile('SKILL.md')).toEqual(markdown)
  await expect(fixed.readFile('references/data.txt')).rejects.toThrow()
  await expect(installation.snapshotFixed(receipt)).rejects.toThrow()
  await expect(installation.current(packageId)).rejects.toThrow()
  writeFileSync(unrelated, resource)
  const manifest = join(base, 'manifest.json')
  writeFileSync(manifest, '[]')
  await expect(fixed.readFile('SKILL.md')).rejects.toThrow()
})

it('rejects changed fixed-file bytes and directory permissions after snapshot capture', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  const receipt = await installation.activate(plan.operationId, '1', '0')
  const fixed = await installation.snapshotFixed(receipt)
  const base = join(root, 'skillhub-versions', plan.operationId)
  const file = join(base, 'files', 'references', 'data.txt')
  const changed = Buffer.from(resource)
  changed[0] = changed[0]! ^ 1
  writeFileSync(file, changed)
  await expect(fixed.readFile('references/data.txt')).rejects.toThrow()
  writeFileSync(file, resource)
  if (process.platform !== 'win32') {
    const directory = join(base, 'files')
    chmodSync(directory, 0o755)
    await expect(fixed.readFile('SKILL.md')).rejects.toThrow()
    chmodSync(directory, 0o700)
  }
  expect(await fixed.readFile('references/data.txt')).toEqual(resource)
})

it('rejects the wrong Profile, key, generation and stale revision before activation', async () => {
  const { installation } = await store()
  const evidence = archive()
  const plan = target('version-1', evidence)
  for (const changed of [
    { profileId: randomUUID() }, { hostKeyId: 'b'.repeat(64) }, { bindingGeneration: '2' },
  ]) await expect(installation.prepare({ ...plan, ...changed }, evidence.bytes)).rejects.toThrow()
  await installation.prepare(plan, evidence.bytes)
  await expect(installation.activate(plan.operationId, '2', '0')).rejects.toThrow()
  await expect(installation.activate(plan.operationId, '1', '1')).rejects.toThrow()
  expect(await installation.current(packageId)).toBeNull()
})

it('keeps the current pointer unchanged when its grant closes before the atomic switch', async () => {
  const { root, installation } = await store()
  const evidence = archive()
  const plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  let checks = 0
  await expect(installation.activate(plan.operationId, '1', '0', () => {
    if (++checks === 2) throw new Error('grant closed')
  })).rejects.toThrow('grant closed')
  expect(await installation.current(packageId)).toBeNull()
  expect(readdirSync(root).some(name => name.startsWith('skillhub-current-'))).toBe(false)
})

it('keeps one immutable receipt for duplicate commits and recovers it after restart', async () => {
  const { root, installation } = await store()
  const evidence = archive()
  const plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  const receipt = await installation.activate(plan.operationId, '1', '0')
  expect(await installation.activate(plan.operationId, '1', '0')).toEqual(receipt)
  await expect(installation.prepare({ ...plan, versionId: 'forged' }, evidence.bytes)).rejects.toThrow()
  const reopened = await createSkillHubPackageInstallationStore(root, profileId, hostKeyId, '1')
  expect(await reopened.current(packageId)).toEqual(receipt)
  expect(await reopened.readFile(packageId, 'SKILL.md')).toEqual(markdown)
})

it('rejects a changed prepared file and retains the previous receipt', async () => {
  const { root, installation } = await store()
  const first = archive()
  const prior = target('version-1', first)
  await installation.prepare(prior, first.bytes)
  const receipt = await installation.activate(prior.operationId, '1', '0')
  const next = archive(Buffer.from('replacement\n'))
  const plan = { ...target('version-2', next), expectedRevision: '1' }
  await installation.prepare(plan, next.bytes)
  writeFileSync(join(root, 'skillhub-prepared', plan.operationId, 'files', 'references', 'data.txt'), 'tampered\n')
  await expect(installation.activate(plan.operationId, '1', '1')).rejects.toThrow()
  expect(await installation.current(packageId)).toEqual(receipt)
  expect(await installation.readFile(packageId, 'references/data.txt')).toEqual(resource)
})

it('keeps independent installed versions for separate assets in one Profile', async () => {
  const { installation } = await store()
  const first = archive()
  const one = target('version-1', first)
  const two = { ...target('version-2', first), packageId: 'package-2' }
  await installation.prepare(one, first.bytes)
  await installation.prepare(two, first.bytes)
  const oneReceipt = await installation.activate(one.operationId, '1', '0')
  const twoReceipt = await installation.activate(two.operationId, '1', '0')
  expect(await installation.current(packageId)).toEqual(oneReceipt)
  expect(await installation.current('package-2')).toEqual(twoReceipt)
})

it('allows only one concurrent activation at the same asset revision', async () => {
  const { installation } = await store()
  const evidence = archive()
  const one = target('version-1', evidence)
  const two = target('version-2', evidence)
  await installation.prepare(one, evidence.bytes)
  await installation.prepare(two, evidence.bytes)
  const attempts = await Promise.allSettled([
    installation.activate(one.operationId, '1', '0'),
    installation.activate(two.operationId, '1', '0'),
  ])
  expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1)
  expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(1)
  const winner = attempts.find(item => item.status === 'fulfilled')
  expect(await installation.current(packageId)).toEqual(winner?.status === 'fulfilled' ? winner.value : null)
})

it('rejects a forged persisted receipt rather than reporting it as a Host fact', async () => {
  const { root, installation } = await store()
  const evidence = archive()
  const plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  await installation.activate(plan.operationId, '1', '0')
  const pointer = join(root, 'skillhub-current', `${packageId}.json`)
  const receipt = await installation.current(packageId)
  writeFileSync(pointer, JSON.stringify({ ...receipt, versionId: 'forged' }))
  await expect(installation.current(packageId)).rejects.toThrow()
})

it('does not accept a corrupted duplicate prepare as an idempotent package', async () => {
  const { root, installation } = await store()
  const evidence = archive()
  const plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  writeFileSync(join(root, 'skillhub-prepared', plan.operationId, 'files', 'SKILL.md'), 'changed')
  await expect(installation.prepare(plan, evidence.bytes)).rejects.toThrow()
  await expect(installation.activate(plan.operationId, '1', '0')).rejects.toThrow()
  expect(await installation.current(packageId)).toBeNull()
})

it('preserves text, reference, template, and declared executable bytes from one snapshot', async () => {
  const { root, installation } = await store()
  const files = [
    { path: 'SKILL.md', mode: '0644', bytes: markdown },
    { path: 'references/data.txt', mode: '0644', bytes: resource },
    { path: 'scripts/run.sh', mode: '0755', bytes: Buffer.from('#!/bin/sh\nprintf ok\\n\n') },
    { path: 'templates/output.txt', mode: '0644', bytes: Buffer.from('template-value\n') },
  ] as const
  const zip = new AdmZip()
  for (const file of files) zip.addFile(file.path, file.bytes, '', file.mode === '0755' ? 0o755 : 0o644)
  const bytes = zip.toBuffer()
  const manifestSha256 = sha(JSON.stringify(['slark-skillhub-manifest-v1', files.map(file =>
    [file.path, file.mode, file.bytes.length, sha(file.bytes)])]))
  const plan = target('version-1', { bytes, archiveSha256: sha(bytes), manifestSha256 })
  await installation.prepare(plan, bytes)
  await installation.activate(plan.operationId, '1', '0')
  for (const file of files) expect(await installation.readFile(packageId, file.path)).toEqual(file.bytes)
  if (process.platform !== 'win32') expect(statSync(join(root, 'skillhub-versions', plan.operationId,
    'files', 'scripts', 'run.sh')).mode & 0o777).toBe(0o755)
})

it('binds the store factory and refuses invalid roots, plans, and missing versions', async () => {
  const { root, installation } = await store()
  const factory = createSkillHubPackageStoreFactory(() => root)
  expect(await (await factory(profileId, '1', hostKeyId)).current(packageId)).toBeNull()
  for (const identity of [
    ['bad', hostKeyId, '1'], [profileId, 'bad', '1'], [profileId, hostKeyId, '0'],
  ] as const) await expect(createSkillHubPackageInstallationStore(root, identity[0], identity[1], identity[2]))
    .rejects.toThrow()
  const evidence = archive(), plan = target('version-1', evidence)
  for (const changed of [
    { operationId: 'bad' }, { packageId: '../bad' }, { expectedRevision: '01' },
    { versionId: '' }, { skillSlug: 'Bad Slug' }, { version: ' 1.0.0' },
    { archiveSha256: 'bad' }, { manifestSha256: 'bad' }, { extra: true },
  ]) await expect(installation.prepare({ ...plan, ...changed }, evidence.bytes)).rejects.toThrow()
  await expect(installation.activate(randomUUID(), '1', '0')).rejects.toThrow()
  await expect(installation.activate('bad', '1', '0')).rejects.toThrow()
  await expect(installation.current('../bad')).rejects.toThrow()
  await expect(installation.readFile(packageId, '../SKILL.md')).rejects.toThrow()
  await expect(installation.readFile(packageId, 'SKILL.md')).rejects.toThrow()
})

it('rejects an altered root or private store directory before reading Host facts', async () => {
  const { root, installation } = await store()
  const prepared = join(root, 'skillhub-prepared')
  if (process.platform !== 'win32') {
    chmodSync(prepared, 0o755)
    await expect(installation.current(packageId)).rejects.toThrow()
    chmodSync(prepared, 0o700)
  }
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  await installation.activate(plan.operationId, '1', '0')
  const file = join(root, 'skillhub-versions', plan.operationId, 'files', 'SKILL.md')
  unlinkSync(file)
  if (process.platform === 'win32') writeFileSync(file, 'tampered')
  else symlinkSync(join(root, 'skillhub-prepared'), file)
  await expect(installation.current(packageId)).rejects.toThrow()
})

it('rejects malformed and mismatched persisted receipts', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  const receipt = await installation.activate(plan.operationId, '1', '0')
  const pointer = join(root, 'skillhub-current', `${packageId}.json`)
  for (const changed of [
    { operationId: 'bad' }, { packageId: 'other' }, { profileId: randomUUID() },
    { hostKeyId: 'b'.repeat(64) }, { bindingGeneration: '2' }, { revision: 'bad' },
    { archiveSha256: 'bad' }, { manifestSha256: 'bad' }, { readiness: 'loaded' },
    { loadEvidenceId: randomUUID() }, { versionId: 'forged' },
  ]) {
    writeFileSync(pointer, JSON.stringify({ ...receipt, ...changed }))
    await expect(installation.current(packageId)).rejects.toThrow()
  }
  writeFileSync(pointer, 'invalid json')
  await expect(installation.current(packageId)).rejects.toThrow()
  writeFileSync(pointer, JSON.stringify(receipt))
  expect(await installation.current(packageId)).toEqual(receipt)
})

it('rejects unsafe archive members and Skill metadata before creating a prepared version', async () => {
  const { root, installation } = await store()
  const cases: ReadonlyArray<ReadonlyArray<readonly [string, Buffer]>> = [
    [],
    [['references/', Buffer.alloc(0)]],
    [['../SKILL.md', markdown]],
    [['/SKILL.md', markdown]],
    [['SKILL.md', markdown], ['skill.md', markdown]],
    [['references/data.txt', resource]],
    [['SKILL.md', Buffer.from('not frontmatter')]],
    [['SKILL.md', Buffer.from('---\nname: other\ndescription: Example\nversion: 1.0.0\n---\n')]],
    [['SKILL.md', Buffer.from('---\nname: example\ndescription: \nversion: 1.0.0\n---\n')]],
    [['SKILL.md', Buffer.from('---\nname: example\nname: example\ndescription: Example\nversion: 1.0.0\n---\n')]],
    [['SKILL.md', Buffer.from('---\nnull\n---\n')]],
    [['SKILL.md', Buffer.from('---\n- example\n---\n')]],
    [['SKILL.md', markdown], ['SKILL.md/data.txt', resource]],
  ]
  for (const entries of cases) {
    const zip = new AdmZip()
    for (const [path, bytes] of entries) zip.addFile(path, bytes)
    const bytes = zip.toBuffer()
    const plan = target('invalid', { bytes, archiveSha256: sha(bytes),
      manifestSha256: 'b'.repeat(64) })
    await expect(installation.prepare(plan, bytes)).rejects.toThrow()
    expect(readdirSync(join(root, 'skillhub-prepared'))).not.toContain(plan.operationId)
  }
})

it('refuses missing paths and never treats a prepared version as a current pointer', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  await expect(installation.readFile(packageId, 'SKILL.md')).rejects.toThrow()
  const receipt = await installation.activate(plan.operationId, '1', '0')
  await expect(installation.readFile(packageId, 'missing.txt')).rejects.toThrow()
  const pointer = join(root, 'skillhub-current', `${packageId}.json`)
  unlinkSync(pointer)
  expect(await installation.current(packageId)).toBeNull()
  expect(await installation.activate(plan.operationId, '1', '0')).toEqual(receipt)
  expect(await installation.readFile(packageId, 'SKILL.md')).toEqual(markdown)
})

it('rejects a stale current pointer when the stored plan is absent or contradictory', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  await installation.activate(plan.operationId, '1', '0')
  const path = join(root, 'skillhub-versions', plan.operationId, 'plan.json')
  writeFileSync(path, JSON.stringify({ ...plan, versionId: 'forged' }))
  await expect(installation.current(packageId)).rejects.toThrow()
  writeFileSync(path, JSON.stringify(plan))
  unlinkSync(path)
  await expect(installation.current(packageId)).rejects.toThrow()
})

it('rejects a competing prepared plan for an already installed operation', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  await installation.activate(plan.operationId, '1', '0')
  const duplicate = join(root, 'skillhub-prepared', plan.operationId)
  mkdirSync(duplicate)
  writeFileSync(join(duplicate, 'plan.json'), JSON.stringify({ ...plan, versionId: 'forged' }))
  await expect(installation.activate(plan.operationId, '1', '0')).rejects.toThrow()
})

it('rejects a missing or untrusted package file during receipt readback', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  await installation.activate(plan.operationId, '1', '0')
  const file = join(root, 'skillhub-versions', plan.operationId, 'files', 'SKILL.md')
  chmodSync(file, 0o600)
  if (process.platform !== 'win32') await expect(installation.current(packageId)).rejects.toThrow()
  chmodSync(file, 0o644)
  unlinkSync(file)
  await expect(installation.current(packageId)).rejects.toThrow()
})

it('accepts exact duplicate preparation and rejects untrusted version directories', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  await expect(installation.prepare(plan, evidence.bytes)).resolves.toBeUndefined()
  await installation.activate(plan.operationId, '1', '0')
  const files = join(root, 'skillhub-versions', plan.operationId, 'files')
  if (process.platform !== 'win32') {
    chmodSync(files, 0o755)
    await expect(installation.current(packageId)).rejects.toThrow()
    chmodSync(files, 0o700)
  }
  const manifest = join(root, 'skillhub-versions', plan.operationId, 'manifest.json')
  const changed = JSON.parse(readFileSync(manifest, 'utf8')) as Array<Record<string, unknown>>
  changed[0]!.size = 1
  writeFileSync(manifest, JSON.stringify(changed))
  await expect(installation.current(packageId)).rejects.toThrow()
  writeFileSync(manifest, '[]')
  await expect(installation.current(packageId)).rejects.toThrow()
  unlinkSync(manifest)
  await expect(installation.current(packageId)).rejects.toThrow()
})

it('refuses a changed parent directory and a coherent manifest without SKILL.md', async () => {
  const { root, installation } = await store()
  const evidence = archive(), plan = target('version-1', evidence)
  await installation.prepare(plan, evidence.bytes)
  const receipt = await installation.activate(plan.operationId, '1', '0')
  const base = join(root, 'skillhub-versions', plan.operationId)
  const parent = join(base, 'files', 'references')
  if (process.platform !== 'win32') {
    chmodSync(parent, 0o755)
    await expect(installation.current(packageId)).rejects.toThrow()
    chmodSync(parent, 0o700)
  }
  const manifestPath = join(base, 'manifest.json')
  const files = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<Record<string, unknown>>
  files[0]!.path = 'OTHER.md'
  const manifestSha256 = sha(JSON.stringify(['slark-skillhub-manifest-v1',
    files.map(file => [file.path, file.mode, file.size, file.sha256])]))
  writeFileSync(join(base, 'files', 'OTHER.md'), markdown)
  unlinkSync(join(base, 'files', 'SKILL.md'))
  writeFileSync(manifestPath, JSON.stringify(files))
  writeFileSync(join(base, 'plan.json'), JSON.stringify({ ...plan, manifestSha256 }))
  writeFileSync(join(root, 'skillhub-current', `${packageId}.json`),
    JSON.stringify({ ...receipt, manifestSha256 }))
  await expect(installation.current(packageId)).rejects.toThrow()
})

it('requires a private existing root and rejects a changed root after opening', async () => {
  const { root, installation } = await store()
  const regular = join(root, 'ordinary.txt')
  writeFileSync(regular, 'file')
  await expect(createSkillHubPackageInstallationStore(regular, profileId, hostKeyId, '1')).rejects.toThrow()
  if (process.platform !== 'win32') {
    chmodSync(root, 0o755)
    await expect(installation.current(packageId)).rejects.toThrow()
    chmodSync(root, 0o700)
  }
})

it('rejects a replaced root and non-directory package paths on every platform', async () => {
  {
    const { root, installation } = await store()
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { mode: 0o700 })
    await expect(installation.current(packageId)).rejects.toThrow()
  }
  {
    const { root, installation } = await store()
    const prepared = join(root, 'skillhub-prepared')
    rmSync(prepared, { recursive: true, force: true })
    writeFileSync(prepared, 'blocked')
    await expect(installation.current(packageId)).rejects.toThrow()
  }
  for (const broken of ['files', 'references'] as const) {
    const { root, installation } = await store()
    const evidence = archive(), plan = target('version-1', evidence)
    await installation.prepare(plan, evidence.bytes)
    await installation.activate(plan.operationId, '1', '0')
    const path = join(root, 'skillhub-versions', plan.operationId, 'files',
      ...(broken === 'references' ? ['references'] : []))
    rmSync(path, { recursive: true, force: true })
    writeFileSync(path, 'blocked')
    await expect(installation.current(packageId)).rejects.toThrow()
  }
})

it('rejects malformed manifest evidence even when its persisted digest is internally consistent', async () => {
  for (const change of [
    (file: Record<string, unknown>) => { file.path = '../escape' },
    (file: Record<string, unknown>) => { file.sha256 = 'invalid' },
    (file: Record<string, unknown>) => { file.size = -1 },
    (file: Record<string, unknown>) => { file.mode = '0777' },
  ]) {
    const { root, installation } = await store()
    const evidence = archive(), plan = target('version-1', evidence)
    await installation.prepare(plan, evidence.bytes)
    const receipt = await installation.activate(plan.operationId, '1', '0')
    const base = join(root, 'skillhub-versions', plan.operationId)
    const manifestPath = join(base, 'manifest.json')
    const files = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<Record<string, unknown>>
    change(files[0]!)
    const manifestSha256 = sha(JSON.stringify(['slark-skillhub-manifest-v1',
      files.map(file => [file.path, file.mode, file.size, file.sha256])]))
    writeFileSync(manifestPath, JSON.stringify(files))
    writeFileSync(join(base, 'plan.json'), JSON.stringify({ ...plan, manifestSha256 }))
    writeFileSync(join(root, 'skillhub-current', `${packageId}.json`),
      JSON.stringify({ ...receipt, manifestSha256 }))
    await expect(installation.current(packageId)).rejects.toThrow()
  }
})

it('rejects unsafe ZIP metadata before any package files are prepared', async () => {
  const { root, installation } = await store()
  const original = archive().bytes
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  expect(central).toBeGreaterThan(0)
  const mutations = [
    (bytes: Buffer) => bytes.writeUInt32LE(0o120777 * 65536, central + 38),
    (bytes: Buffer) => bytes.writeUInt32LE(11 * 1024 * 1024, central + 24),
    (bytes: Buffer) => bytes.writeUInt32LE(0, central + 16),
    (bytes: Buffer) => { bytes.writeUInt16LE(9, central + 10); bytes.writeUInt16LE(9, 8) },
    (bytes: Buffer) => bytes.writeUInt16LE(1, central + 8),
  ]
  for (const mutate of mutations) {
    const bytes = Buffer.from(original)
    mutate(bytes)
    const plan = target('invalid', { bytes, archiveSha256: sha(bytes),
      manifestSha256: 'b'.repeat(64) })
    await expect(installation.prepare(plan, bytes)).rejects.toThrow()
    expect(readdirSync(join(root, 'skillhub-prepared'))).not.toContain(plan.operationId)
  }
  const onlyDirectory = new AdmZip()
  onlyDirectory.addFile('references/', Buffer.alloc(0))
  const badDirectory = onlyDirectory.toBuffer()
  const directoryHeader = badDirectory.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  badDirectory.writeUInt32LE(1, directoryHeader + 16)
  const badPlan = target('invalid-directory', { bytes: badDirectory, archiveSha256: sha(badDirectory),
    manifestSha256: 'b'.repeat(64) })
  await expect(installation.prepare(badPlan, badDirectory)).rejects.toThrow()
})

it('accepts a stored ZIP member with the same verified file manifest', async () => {
  const { installation } = await store()
  const zip = new AdmZip()
  zip.addFile('SKILL.md', markdown)
  const entry = zip.getEntry('SKILL.md')
  expect(entry).not.toBeNull()
  entry!.header.method = 0
  const bytes = zip.toBuffer()
  expect(new AdmZip(bytes).getEntry('SKILL.md')?.header.method).toBe(0)
  const manifestSha256 = sha(JSON.stringify(['slark-skillhub-manifest-v1',
    [['SKILL.md', '0644', markdown.length, sha(markdown)]]]))
  const plan = target('stored-version', { bytes, archiveSha256: sha(bytes), manifestSha256 })
  await installation.prepare(plan, bytes)
  await installation.activate(plan.operationId, '1', '0')
  expect(await installation.readFile(packageId, 'SKILL.md')).toEqual(markdown)
})

it('removes staging data when the atomic preparation publish fails', async () => {
  const { root, installation } = await store()
  const prepared = join(root, 'skillhub-prepared')
  const evidence = archive(), plan = target('version-1', evidence)
  const collision = join(prepared, plan.operationId)
  mkdirSync(collision)
  writeFileSync(join(collision, 'blocker.txt'), 'blocked')
  await expect(installation.prepare(plan, evidence.bytes)).rejects.toThrow()
  expect(readdirSync(join(root, 'skillhub-staging'))).toEqual([])
})
