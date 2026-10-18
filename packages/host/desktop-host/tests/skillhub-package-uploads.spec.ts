/** REQ-20261013-0021 / 24205. Connection-owned complete-package transfer. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, expect, it } from 'vitest'
import { createSkillHubPackageInstallationStore } from '../src/skillhub-package-install.ts'
import { SkillHubPackageUploads } from '../src/skillhub-package-uploads.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const profileId = '11111111-1111-4111-8111-111111111111'
const hostKeyId = 'a'.repeat(64)
const markdown = Buffer.from('---\nname: example\ndescription: Example\nversion: 1.0.0\n---\n# Example\n')
function fixture() {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', markdown)
  const archive = zip.toBuffer()
  const plan = {
    operationId: randomUUID(), packageId: 'package-1', profileId, hostKeyId,
    bindingGeneration: '1', expectedRevision: '0', versionId: 'version-1',
    skillSlug: 'example', version: '1.0.0', archiveSha256: sha(archive),
    manifestSha256: sha(JSON.stringify(['slark-skillhub-manifest-v1',
      [['SKILL.md', '0644', markdown.length, sha(markdown)]]])),
  }
  return { archive, plan }
}
async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skillhub-upload-'))
  roots.push(root)
  const store = await createSkillHubPackageInstallationStore(root, profileId, hostKeyId, '1')
  const uploads = new SkillHubPackageUploads()
  const controller = new AbortController()
  const { archive, plan } = fixture()
  let current = true
  let authorized = true
  const input = (offset: number, bytes: Buffer) => ({
    ownerId: 'owner', bindingKey: `${profileId}:1:${hostKeyId}`, plan,
    totalBytes: archive.length, offset, bytes, signal: controller.signal,
    authorize: () => { if (!authorized) throw Error('revoked') },
    capture: () => ({
      assertCurrent: () => { if (!current) throw Error('profile_changed') },
      prepare: store.prepare,
    }),
  })
  return { root, store, uploads, controller, archive, plan, input,
    revoke: () => { authorized = false }, changeProfile: () => { current = false } }
}

it('prepares only after every bounded sequential fragment and preserves complete bytes', async () => {
  const h = await harness()
  let offset = 0
  while (offset < h.archive.length) {
    const end = Math.min(offset + 19, h.archive.length)
    const result = await h.uploads.accept(h.input(offset, h.archive.subarray(offset, end)))
    offset = result.nextOffset
    expect(result.prepared).toBe(offset === h.archive.length)
  }
  const receipt = await h.store.activate(h.plan.operationId, '1', '0')
  expect(receipt.archiveSha256).toBe(h.plan.archiveSha256)
  expect(await h.store.readFile('package-1', 'SKILL.md')).toEqual(markdown)
})

it('drops a half upload on disconnect without creating a prepared package', async () => {
  const h = await harness()
  const first = h.archive.subarray(0, 20)
  expect(await h.uploads.accept(h.input(0, first))).toEqual({ nextOffset: 20, prepared: false })
  h.controller.abort()
  await expect(h.uploads.accept(h.input(20, h.archive.subarray(20, 30)))).rejects.toThrow()
  expect(existsSync(join(h.root, 'skillhub-prepared', h.plan.operationId))).toBe(false)
  expect(await h.store.current('package-1')).toBeNull()
})

it('acknowledges an identical retry but rejects changed bytes, stale grant and competing connections', async () => {
  const h = await harness()
  const first = h.archive.subarray(0, 20)
  await h.uploads.accept(h.input(0, first))
  expect(await h.uploads.accept(h.input(0, first))).toEqual({ nextOffset: 20, prepared: false })
  const rival = new AbortController()
  await expect(h.uploads.accept({ ...h.input(0, first), signal: rival.signal })).rejects.toThrow()
  expect(existsSync(join(h.root, 'skillhub-prepared', h.plan.operationId))).toBe(false)
  expect(await h.uploads.accept(h.input(0, first))).toEqual({ nextOffset: 20, prepared: false })
  await expect(h.uploads.accept(h.input(0, Buffer.from('changed-fragment-0000')))).rejects.toThrow()
  await h.uploads.accept(h.input(0, first))
  h.changeProfile()
  await expect(h.uploads.accept(h.input(20, h.archive.subarray(20, 40)))).rejects.toThrow()
  expect(existsSync(join(h.root, 'skillhub-prepared', h.plan.operationId))).toBe(false)
})

it('rejects revocation and a changed archive digest before preparation', async () => {
  const h = await harness()
  await h.uploads.accept(h.input(0, h.archive.subarray(0, 20)))
  h.revoke()
  await expect(h.uploads.accept(h.input(20, h.archive.subarray(20, 40)))).rejects.toThrow()
  const next = await harness()
  const forged = { ...next.plan, archiveSha256: 'b'.repeat(64) }
  await expect(next.uploads.accept({ ...next.input(0, next.archive), plan: forged })).rejects.toThrow()
  expect(existsSync(join(next.root, 'skillhub-prepared', next.plan.operationId))).toBe(false)
})

it('rejects oversized fragments, gaps, and disconnect during preparation', async () => {
  const h = await harness()
  await expect(h.uploads.accept(h.input(1, h.archive.subarray(0, 20)))).rejects.toThrow()
  await expect(h.uploads.accept({ ...h.input(0, h.archive.subarray(0, 20)), ownerId: '' })).rejects.toThrow()
  await expect(h.uploads.accept({ ...h.input(0, h.archive.subarray(0, 20)), bindingKey: '' })).rejects.toThrow()
  await expect(h.uploads.accept({ ...h.input(0, h.archive.subarray(0, 20)),
    plan: { ...h.plan, operationId: '' } })).rejects.toThrow()
  await expect(h.uploads.accept(h.input(0, Buffer.alloc(32 * 1024 + 1)))).rejects.toThrow()
  await expect(h.uploads.accept({ ...h.input(0, h.archive.subarray(0, 20)),
    totalBytes: 110 * 1024 * 1024 + 1 })).rejects.toThrow()
  await h.uploads.accept(h.input(0, h.archive.subarray(0, 20)))
  await expect(h.uploads.accept(h.input(21, h.archive.subarray(20, 40)))).rejects.toThrow()
  const next = await harness()
  let finish!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => { finish = resolve })
  const preparing = new Promise<void>((resolve) => { entered = resolve })
  const pending = next.uploads.accept({ ...next.input(0, next.archive), capture: () => ({
    assertCurrent: () => undefined,
    prepare: async () => { entered(); await held },
  }) })
  await preparing
  next.controller.abort()
  finish()
  await expect(pending).rejects.toThrow()
})

it('keeps the owner upload alive when a competing connection arrives during preparation', async () => {
  const h = await harness()
  let finish!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => { finish = resolve })
  const preparing = new Promise<void>((resolve) => { entered = resolve })
  const pending = h.uploads.accept({ ...h.input(0, h.archive), capture: () => ({
    assertCurrent: () => undefined,
    prepare: async () => { entered(); await held },
  }) })
  await preparing
  const rival = new AbortController()
  await expect(h.uploads.accept({ ...h.input(0, h.archive.subarray(0, 20)),
    signal: rival.signal })).rejects.toThrow()
  finish()
  await expect(pending).resolves.toEqual({ nextOffset: h.archive.length, prepared: true })
})

it('rejects a grant that closes during the final synchronous receiver check', async () => {
  const h = await harness()
  let checks = 0
  await expect(h.uploads.accept({ ...h.input(0, h.archive), capture: () => ({
    assertCurrent: () => { if (++checks === 2) h.controller.abort() },
    prepare: h.store.prepare,
  }) })).rejects.toThrow()
  expect(existsSync(join(h.root, 'skillhub-prepared', h.plan.operationId))).toBe(false)
})
