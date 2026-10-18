/** REQ-20261013-0021 / 24205. Host facts, never the Server's project-install projection. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, expect, it } from 'vitest'
import { createSkillHubPackageInstallationStore } from '../src/skillhub-package-install.ts'

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
