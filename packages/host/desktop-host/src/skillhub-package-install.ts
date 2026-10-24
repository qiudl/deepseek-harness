/** REQ-20261013-0021 / 24205. Profile-owned, immutable SkillHub package snapshots.
 * The Host control boundary must verify the current Profile grant before calling
 * this store. No Server project-install row or cache entry is a Host receipt.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'
import AdmZip from 'adm-zip'
import { parseDocument } from 'yaml'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA = /^[a-f0-9]{64}$/u
const REVISION = /^(?:0|[1-9][0-9]{0,17})$/u
const MAX_ARCHIVE = 110 * 1024 * 1024
const MAX_TOTAL = 100 * 1024 * 1024
const MAX_FILE = 10 * 1024 * 1024
const MANIFEST_SCHEMA = 'slark-skillhub-manifest-v1'
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const fail = (): never => { throw Error('skillhub_package_unavailable') }
/* v8 ignore next -- POSIX mode bits are not authoritative on Windows; Linux coverage exercises this branch. */
const privateMode = (mode: number) => process.platform === 'win32' || (mode & 0o077) === 0

/** Fixed package identity and expected Profile revision supplied by the authorized installer. */
export interface SkillHubPackagePlan {
  readonly operationId: string
  readonly packageId: string
  readonly profileId: string
  readonly hostKeyId: string
  readonly bindingGeneration: string
  readonly expectedRevision: string
  readonly versionId: string
  readonly skillSlug: string
  readonly version: string
  readonly archiveSha256: string
  readonly manifestSha256: string
}
/** Host-local activation fact for one complete package; loading requires separate evidence. */
export interface SkillHubPackageReceipt {
  readonly operationId: string
  readonly packageId: string
  readonly profileId: string
  readonly hostKeyId: string
  readonly bindingGeneration: string
  readonly revision: string
  readonly versionId: string
  readonly archiveSha256: string
  readonly manifestSha256: string
  readonly readiness: 'prepared'
  readonly loadEvidenceId: null
}
interface FileEvidence { path: string; mode: '0644' | '0755'; size: number; sha256: string; bytes: Buffer }
type StoredFile = Omit<FileEvidence, 'bytes' | 'mode'> & { mode: string }
type StoredReceipt = Omit<SkillHubPackageReceipt, 'readiness' | 'loadEvidenceId'>
  & { readiness: string; loadEvidenceId: unknown }
/** Verified fixed package metadata; each file read rechecks its own bytes and stored identity. */
export type SkillHubPackageSnapshot = Readonly<{
  receipt: SkillHubPackageReceipt
  files: readonly Readonly<{
    path: string
    mode: '0644' | '0755'
    size: number
    sha256: string
  }>[]
  readFile(path: string): Promise<Buffer>
}>
type SkillHubPackageInstallationStore = Readonly<{
  current(packageId: string): Promise<SkillHubPackageReceipt | null>
  snapshot(packageId: string): Promise<SkillHubPackageSnapshot>
  /** Reopen one exact activated operation without following the current pointer. */
  snapshotFixed(receipt: SkillHubPackageReceipt): Promise<SkillHubPackageSnapshot>
  prepare(plan: SkillHubPackagePlan, archive: Buffer): Promise<void>
  activate(operationId: string, bindingGeneration: string, expectedRevision: string,
    assertCurrent?: () => void): Promise<SkillHubPackageReceipt>
  readFile(packageId: string, path: string): Promise<Buffer>
}>

/** Resolve the current Profile's private package root before opening its store.
 * @param resolveRoot - platform-owned Profile and private-directory check.
 * @returns a Host control callback bound to that platform-owned root.
 */
export function createSkillHubPackageStoreFactory(resolveRoot: (profileId: string) => string):
(profileId: string, bindingGeneration: string, hostKeyId: string) => Promise<SkillHubPackageInstallationStore> {
  return (profileId, bindingGeneration, hostKeyId) => createSkillHubPackageInstallationStore(
    resolveRoot(profileId), profileId, hostKeyId, bindingGeneration)
}

function safePath(value: string): boolean {
  return value.length > 0 && value.length <= 500 && value.normalize('NFC') === value
    && !/[\\\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !value.startsWith('/') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'
      && !/[:*?"<>|]/u.test(part) && !/[. ]$/u.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))
}
function planValid(plan: SkillHubPackagePlan | null, profileId: string, hostKeyId: string, bindingGeneration: string): void {
  if (!plan || Object.keys(plan).length !== 11 || !UUID.test(plan.operationId)
    || !/^[a-zA-Z0-9_-]{1,100}$/u.test(plan.packageId)
    || plan.profileId !== profileId || plan.hostKeyId !== hostKeyId
    || plan.bindingGeneration !== bindingGeneration
    || !REVISION.test(plan.expectedRevision)
    || !plan.versionId || plan.versionId.length > 200 || plan.versionId.trim() !== plan.versionId
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(plan.skillSlug) || plan.skillSlug.length > 200
    || !plan.version || plan.version.length > 200 || plan.version.trim() !== plan.version
    || !SHA.test(plan.archiveSha256) || !SHA.test(plan.manifestSha256)) fail()
}
function inspectArchive(archive: Buffer, plan: SkillHubPackagePlan): FileEvidence[] {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_ARCHIVE
    || digest(archive) !== plan.archiveSha256) fail()
  try {
    const entries = new AdmZip(archive).getEntries()
    if (!entries.length || entries.length > 500) fail()
    const seen = new Set<string>(), files: FileEvidence[] = []
    let total = 0
    for (const entry of entries) {
      const path = entry.isDirectory ? entry.entryName.slice(0, -1) : entry.entryName
      if (!safePath(path) || seen.has(path.toLocaleLowerCase('en-US'))
        || entry.header.encrypted) fail()
      seen.add(path.toLocaleLowerCase('en-US'))
      const mode = entry.attr >>> 16, kind = mode & 0o170000
      if ((mode & 0o7000) || (kind && kind !== (entry.isDirectory ? 0o040000 : 0o100000))) fail()
      if (entry.isDirectory) {
        if (entry.header.size !== 0 || entry.header.crc !== 0) fail()
        continue
      }
      if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0
        || entry.header.size > MAX_FILE || total + entry.header.size > MAX_TOTAL) fail()
      if (![0, 8].includes(entry.header.method)) fail()
      const compressed = entry.getCompressedData()
      /* v8 ignore next -- adm-zip derives returned compressed bytes from this header and rejects truncated ZIP data before returning. */
      if (compressed.length !== entry.header.compressedSize) fail()
      const bytes = entry.header.method === 0
        ? compressed : inflateRawSync(compressed, { maxOutputLength: MAX_FILE + 1 })
      if (bytes.length !== entry.header.size || crc32(bytes) !== entry.header.crc) fail()
      total += bytes.length
      files.push({ path, mode: (mode & 0o111) ? '0755' : '0644', size: bytes.length,
        sha256: digest(bytes), bytes })
    }
    if (!files.length) fail()
    const paths = new Set(files.map(file => file.path.toLocaleLowerCase('en-US')))
    for (const file of files) {
      const parts = file.path.toLocaleLowerCase('en-US').split('/')
      for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) fail()
    }
    const markdown = files.find(file => file.path === 'SKILL.md')
    if (!markdown || markdown.size > 32768) throw Error('skillhub_package_unavailable')
    const value = new TextDecoder('utf-8', { fatal: true }).decode(markdown.bytes)
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(value)
    if (!match) throw Error('skillhub_package_unavailable')
    const metadata = parseDocument(match[1] as string, { uniqueKeys: true, strict: true })
    if (metadata.errors.length) fail()
    const row: unknown = metadata.toJS({ maxAliasCount: 0 })
    if (!row || typeof row !== 'object' || Array.isArray(row)) fail()
    const fields = row as Record<string, unknown>
    if (fields.name !== plan.skillSlug || fields.version !== plan.version
      || typeof fields.description !== 'string' || !fields.description.trim()) fail()
    files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
    const manifest = JSON.stringify([MANIFEST_SCHEMA,
      files.map(file => [file.path, file.mode, file.size, file.sha256])])
    if (digest(manifest) !== plan.manifestSha256) fail()
    return files
  } catch { return fail() }
}

async function writePrivate(path: string, bytes: Buffer | string, mode = 0o600): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try { await file.writeFile(bytes); await file.chmod(mode); await file.sync() }
  finally { await file.close() }
}
async function directorySync(path: string): Promise<void> {
  /* v8 ignore next -- the Win32 directory-handle branch runs only on Windows CI; Linux coverage cannot execute it. */
  if (process.platform === 'win32') return
  /* v8 ignore next -- Win32 cannot open directory handles for fsync; Linux coverage exercises this call. */
  const dir = await open(path, constants.O_RDONLY)
  /* v8 ignore next -- Win32 cannot execute POSIX directory fsync; Linux coverage exercises sync and close. */
  try { await dir.sync() } finally { await dir.close() }
}
async function storedJson<T>(path: string): Promise<T | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { return JSON.parse(await file.readFile({ encoding: 'utf8' })) as T }
    finally { await file.close() }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return fail() }
}

/** Create a Profile-owned package store under the existing single-Host lock.
 * @param root - existing private directory dedicated to this Profile's SkillHub packages.
 * @param profileId - stable local Profile UUID.
 * @param hostKeyId - SHA-256 fingerprint of the Host installation public key.
 * @param bindingGeneration - current local Profile binding generation.
 * @returns bounded package preparation, activation, current receipt, and file read operations.
 */
export async function createSkillHubPackageInstallationStore(root: string, profileId: string,
  hostKeyId: string, bindingGeneration: string): Promise<SkillHubPackageInstallationStore> {
  if (!UUID.test(profileId) || !SHA.test(hostKeyId) || !REVISION.test(bindingGeneration)
    || bindingGeneration === '0') fail()
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink() || !privateMode(info.mode)) fail()
  const canonicalRoot = await realpath(root), inode = info.ino, device = info.dev
  const staging = join(root, 'skillhub-staging'), prepared = join(root, 'skillhub-prepared')
  const versions = join(root, 'skillhub-versions'), pointers = join(root, 'skillhub-current')
  for (const path of [staging, prepared, versions, pointers]) await mkdir(path, { recursive: true, mode: 0o700 })
  const checkRoot = async () => {
    const current = await lstat(root)
    /* v8 ignore next -- the privateMode false arm requires POSIX mode bits. */
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== inode
      || current.dev !== device || !privateMode(current.mode)
      || await realpath(root) !== canonicalRoot) fail()
    for (const path of [staging, prepared, versions, pointers]) {
      const entry = await lstat(path)
      /* v8 ignore next -- the privateMode false arm requires POSIX mode bits. */
      if (!entry.isDirectory() || entry.isSymbolicLink() || !privateMode(entry.mode)) fail()
    }
  }
  await checkRoot()
  async function verifiedFileBytes(base: string, path: string,
    evidence: Pick<StoredFile, 'size' | 'mode' | 'sha256'>): Promise<Buffer> {
    const parts = path.split('/')
    let parent = join(base, 'files')
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part)
      const entry = await lstat(parent)
      /* v8 ignore next -- the privateMode false arm requires POSIX mode bits. */
      if (!entry.isDirectory() || entry.isSymbolicLink() || !privateMode(entry.mode)) fail()
    }
    const file = await open(join(base, 'files', ...parts), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await file.stat()
      /* v8 ignore next 2 -- the mode comparison is POSIX-only; Linux coverage exercises it. */
      if (!stat.isFile() || stat.size !== evidence.size
        || (process.platform !== 'win32' && (stat.mode & 0o777) !== (evidence.mode === '0755' ? 0o755 : 0o644))) fail()
      const bytes = await file.readFile()
      if (digest(bytes) !== evidence.sha256) fail()
      return bytes
    } finally { await file.close() }
  }
  async function verifiedFiles(plan: SkillHubPackagePlan, base: string): Promise<StoredFile[]> {
    for (const path of [base, join(base, 'files')]) {
      const info = await lstat(path)
      /* v8 ignore next -- the privateMode false arm requires POSIX mode bits. */
      if (!info.isDirectory() || info.isSymbolicLink() || !privateMode(info.mode)) fail()
    }
    const files = await storedJson<StoredFile[]>(join(base, 'manifest.json'))
    if (!Array.isArray(files) || !files.length || files.length > 500)
      throw Error('skillhub_package_unavailable')
    const canonical = JSON.stringify([MANIFEST_SCHEMA,
      files.map(file => [file.path, file.mode, file.size, file.sha256])])
    if (digest(canonical) !== plan.manifestSha256) fail()
    for (const evidence of files) {
      if (!safePath(evidence.path) || !SHA.test(evidence.sha256)
        || !Number.isSafeInteger(evidence.size) || evidence.size < 0 || evidence.size > MAX_FILE
        || (evidence.mode !== '0644' && evidence.mode !== '0755')) fail()
      await verifiedFileBytes(base, evidence.path, evidence)
    }
    if (!files.some(file => file.path === 'SKILL.md')) fail()
    return files
  }
  let activationTail: Promise<void> = Promise.resolve()
  async function serializeActivation<T>(action: () => Promise<T>): Promise<T> {
    const previous = activationTail
    let release!: () => void
    activationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await action() } finally { release() }
  }
  async function currentReceipt(packageId: string): Promise<SkillHubPackageReceipt | null> {
    await checkRoot()
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(packageId)) fail()
    const receipt = await storedJson<StoredReceipt>(join(pointers, `${packageId}.json`))
    if (!receipt) return null
    receiptValid(receipt, packageId)
    return receipt as SkillHubPackageReceipt
  }
  async function current(packageId: string): Promise<SkillHubPackageReceipt | null> {
    const receipt = await currentReceipt(packageId)
    if (!receipt) return null
    const plan = await storedJson<SkillHubPackagePlan>(join(versions, receipt.operationId, 'plan.json'))
    if (!plan) throw Error('skillhub_package_unavailable')
    planValid(plan, profileId, hostKeyId, bindingGeneration)
    if (plan.packageId !== packageId || plan.operationId !== receipt.operationId
      || plan.versionId !== receipt.versionId || plan.archiveSha256 !== receipt.archiveSha256
      || plan.manifestSha256 !== receipt.manifestSha256
      || (BigInt(plan.expectedRevision) + 1n).toString() !== receipt.revision) fail()
    await verifiedFiles(plan, join(versions, receipt.operationId))
    return receipt
  }
  function receiptValid(receipt: StoredReceipt | SkillHubPackageReceipt, expectedPackageId?: string) {
    if (Object.keys(receipt).length !== 11 || !UUID.test(receipt.operationId)
      || !/^[a-zA-Z0-9_-]{1,100}$/u.test(receipt.packageId)
      || (expectedPackageId !== undefined && receipt.packageId !== expectedPackageId)
      || receipt.profileId !== profileId || receipt.hostKeyId !== hostKeyId
      || receipt.bindingGeneration !== bindingGeneration || !REVISION.test(receipt.revision)
      || receipt.revision === '0' || !receipt.versionId || receipt.versionId.length > 200
      || receipt.versionId.trim() !== receipt.versionId
      || !SHA.test(receipt.archiveSha256) || !SHA.test(receipt.manifestSha256)
      || receipt.readiness !== 'prepared' || receipt.loadEvidenceId !== null) fail()
  }
  async function fixedPlan(receipt: SkillHubPackageReceipt) {
    receiptValid(receipt)
    const base = join(versions, receipt.operationId)
    const plan = await storedJson<SkillHubPackagePlan>(join(base, 'plan.json'))
    if (!plan) throw Error('skillhub_package_unavailable')
    planValid(plan, profileId, hostKeyId, bindingGeneration)
    if (plan.operationId !== receipt.operationId || plan.packageId !== receipt.packageId
      || plan.versionId !== receipt.versionId || plan.archiveSha256 !== receipt.archiveSha256
      || plan.manifestSha256 !== receipt.manifestSha256
      || (BigInt(plan.expectedRevision) + 1n).toString() !== receipt.revision) fail()
    return { base, plan }
  }
  async function readFixedFile(receipt: SkillHubPackageReceipt, path: string,
    files: SkillHubPackageSnapshot['files']): Promise<Buffer> {
    await checkRoot()
    if (!safePath(path)) fail()
    const { base, plan } = await fixedPlan(receipt)
    for (const directory of [base, join(base, 'files')]) {
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || !privateMode(info.mode)) fail()
    }
    const manifest = await storedJson<StoredFile[]>(join(base, 'manifest.json'))
    if (!Array.isArray(manifest) || !manifest.length || manifest.length > 500
      || digest(JSON.stringify([MANIFEST_SCHEMA,
        manifest.map(file => [file.path, file.mode, file.size, file.sha256])])) !== plan.manifestSha256) fail()
    const evidence = files.find(file => file.path === path)
    if (!evidence) throw Error('skillhub_package_unavailable')
    return verifiedFileBytes(base, path, evidence)
  }
  async function snapshotFixed(receipt: SkillHubPackageReceipt): Promise<SkillHubPackageSnapshot> {
    await checkRoot()
    const fixed = Object.freeze({ ...receipt })
    const { base, plan } = await fixedPlan(fixed)
    const files = Object.freeze((await verifiedFiles(plan, base)).map(file => Object.freeze({
      path: file.path, mode: file.mode as '0644' | '0755',
      size: file.size, sha256: file.sha256,
    })))
    return Object.freeze({ receipt: fixed, files,
      readFile: (path: string) => readFixedFile(fixed, path, files) })
  }
  return Object.freeze({
    current,
    async snapshot(packageId: string) {
      const receipt = await currentReceipt(packageId)
      if (!receipt) throw Error('skillhub_package_unavailable')
      return snapshotFixed(receipt)
    },
    snapshotFixed,
    async prepare(plan: SkillHubPackagePlan, archive: Buffer): Promise<void> {
      await checkRoot(); planValid(plan, profileId, hostKeyId, bindingGeneration)
      const files = inspectArchive(Buffer.from(archive), plan)
      const preparedPath = join(prepared, plan.operationId), versionPath = join(versions, plan.operationId)
      const existingPrepared = await storedJson<SkillHubPackagePlan>(join(preparedPath, 'plan.json'))
      const existingVersion = await storedJson<SkillHubPackagePlan>(join(versionPath, 'plan.json'))
      if (existingPrepared || existingVersion) {
        for (const [existing, path] of [[existingPrepared, preparedPath], [existingVersion, versionPath]] as const) {
          if (!existing) continue
          if (JSON.stringify(existing) !== JSON.stringify(plan)) fail()
          await verifiedFiles(plan, path)
        }
        return
      }
      const stage = join(staging, randomUUID())
      await mkdir(stage, { mode: 0o700 })
      try {
        const fileRoot = join(stage, 'files')
        await mkdir(fileRoot, { mode: 0o700 })
        for (const file of files) {
          const parts = file.path.split('/'), parent = join(fileRoot, ...parts.slice(0, -1))
          await mkdir(parent, { recursive: true, mode: 0o700 })
          await writePrivate(join(fileRoot, ...parts), file.bytes, file.mode === '0755' ? 0o755 : 0o644)
        }
        await writePrivate(join(stage, 'plan.json'), JSON.stringify(plan))
        await writePrivate(join(stage, 'manifest.json'), JSON.stringify(files.map(
          ({ path, mode, size, sha256 }): StoredFile => ({ path, mode, size, sha256 }))))
        await directorySync(stage)
        await rename(stage, preparedPath)
        await directorySync(prepared)
      } catch (error) {
        await rm(stage, { recursive: true, force: true })
        throw error
      }
    },
    async activate(operationId: string, bindingGeneration: string, expectedRevision: string,
      assertCurrent?: () => void): Promise<SkillHubPackageReceipt> {
      return serializeActivation(async () => {
        await checkRoot()
        if (!UUID.test(operationId) || !REVISION.test(bindingGeneration)
        || !REVISION.test(expectedRevision)) fail()
        const preparedPath = join(prepared, operationId), destination = join(versions, operationId)
        const versionPlan = await storedJson<SkillHubPackagePlan>(join(destination, 'plan.json'))
        const preparedPlan = await storedJson<SkillHubPackagePlan>(join(preparedPath, 'plan.json'))
        if (versionPlan && preparedPlan && JSON.stringify(versionPlan) !== JSON.stringify(preparedPlan)) fail()
        const plan = versionPlan ?? preparedPlan
        if (!plan) throw Error('skillhub_package_unavailable')
        planValid(plan, profileId, hostKeyId, bindingGeneration)
        const active = await current(plan.packageId)
        assertCurrent?.()
        if (plan.bindingGeneration !== bindingGeneration || plan.expectedRevision !== expectedRevision) fail()
        if (active?.operationId === operationId) return active
        if ((active?.revision ?? '0') !== expectedRevision) fail()
        const base = versionPlan ? destination : preparedPath
        await verifiedFiles(plan, base)
        const receipt: SkillHubPackageReceipt = {
          operationId, packageId: plan.packageId, profileId, hostKeyId, bindingGeneration,
          revision: (BigInt(expectedRevision) + 1n).toString(), versionId: plan.versionId,
          archiveSha256: plan.archiveSha256, manifestSha256: plan.manifestSha256,
          readiness: 'prepared', loadEvidenceId: null,
        }
        if (!versionPlan)
          await rename(preparedPath, destination)
        await directorySync(versions)
        const temp = join(root, `skillhub-current-${randomUUID()}.json`)
        try {
          await writePrivate(temp, JSON.stringify(receipt))
          assertCurrent?.()
          await rename(temp, join(pointers, `${plan.packageId}.json`))
        } finally { await rm(temp, { force: true }) }
        await directorySync(pointers)
        return receipt
      })
    },
    async readFile(packageId: string, path: string): Promise<Buffer> {
      const receipt = await currentReceipt(packageId)
      if (!receipt) throw Error('skillhub_package_unavailable')
      return (await snapshotFixed(receipt)).readFile(path)
    },
  })
}
