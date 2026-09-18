import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import {
  JsonlMigrationExportService,
  type MigrationOwnerStateBundle,
  type MigrationOwnerTransferBundle,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import { FileJsonlMigrationExportSource } from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/u
const CREDENTIAL_KEY = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

async function ownerDirectory(path: string, uid: number): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o022) !== 0) {
      throw new Error('legacy_migration_source_unsafe')
    }
  } finally { await handle.close() }
}

async function ownerDocument(path: string, uid: number, absent: unknown, ownerPrivate = true): Promise<unknown> {
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absent
    throw error
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.uid !== uid || before.nlink !== 1
      || (ownerPrivate ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0)
      || before.size > MAX_DOCUMENT_BYTES) throw new Error('legacy_migration_source_unsafe')
    const text = await handle.readFile('utf8')
    const after = await handle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('legacy_migration_source_changed')
    }
    const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true })
    if (document.errors.length > 0) throw new Error('legacy_migration_source_schema_unsupported')
    return document.toJS() ?? absent
  } finally { await handle.close() }
}

function map(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('legacy_migration_source_schema_unsupported')
  }
  return value as Record<string, unknown>
}

function jsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || seen.has(value)
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
    throw new Error('legacy_migration_source_schema_unsupported')
  }
  seen.add(value)
  for (const nested of Object.values(value)) jsonValue(nested, seen)
  seen.delete(value)
}

function credentials(value: unknown): { refs: Record<string, string>; records: Record<string, unknown> } {
  const root = map(value)
  const keys = Object.keys(root)
  if (keys.length === 0) return { refs: {}, records: {} }
  const versionedKeys = ['version', 'refs', 'records']
  if (!keys.some(key => versionedKeys.includes(key))) {
    if (Object.entries(root).some(([key, entry]) => !REF.test(key)
      || typeof entry !== 'string' || entry.length === 0)) {
      throw new Error('legacy_migration_source_schema_unsupported')
    }
    return { refs: root as Record<string, string>, records: {} }
  }
  if (root.version !== 1 || keys.some(key => !versionedKeys.includes(key))) {
    throw new Error('legacy_migration_source_schema_unsupported')
  }
  const refs = map(root.refs ?? {})
  const records = map(root.records ?? {})
  if (Object.entries(refs).some(([key, entry]) => !REF.test(key) || typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('legacy_migration_source_schema_unsupported')
  }
  for (const [key, record] of Object.entries(records)) {
    if (!CREDENTIAL_KEY.test(key)) throw new Error('legacy_migration_source_schema_unsupported')
    const fields = map(record)
    if (fields.kind === 'api-key') {
      if (Object.keys(fields).some(field => !['kind', 'key', 'env'].includes(field))
        || fields.key !== undefined && (typeof fields.key !== 'string' || fields.key.length === 0)) {
        throw new Error('legacy_migration_source_schema_unsupported')
      }
      const environment = fields.env === undefined ? {} : map(fields.env)
      if (Object.entries(environment).some(([name, entry]) => !REF.test(name)
        || typeof entry !== 'string' || entry.length === 0)) {
        throw new Error('legacy_migration_source_schema_unsupported')
      }
    } else if (fields.kind === 'grant') {
      if (JSON.stringify(Object.keys(fields).sort()) !== JSON.stringify(['kind', 'payload'])
        || !Object.hasOwn(fields, 'payload')) throw new Error('legacy_migration_source_schema_unsupported')
      jsonValue(fields.payload)
    } else {
      throw new Error('legacy_migration_source_schema_unsupported')
    }
  }
  return { refs: refs as Record<string, string>, records }
}

/** Redacted, source-bound candidate for a later authenticated account claim. */
export interface LegacyModelClaimCandidate {
  readonly id: string
  readonly provider: string
  readonly kind: 'llm' | 'web-search'
  readonly credential: 'present' | 'missing' | 'none'
  readonly sharedCredential: boolean
}

/** Owner-only source inventory; no credential values or references cross to Desktop. */
export interface LegacyModelClaimInventory {
  readonly sourceDigest: string
  readonly candidates: readonly LegacyModelClaimCandidate[]
  readonly unsupportedSettings: number
  readonly unassignedCredentialReferences: number
  readonly unassignedCredentialRecords: number
}

/**
 * Read a redacted inventory from the fixed owner-local legacy home.
 * Candidate ids are selectors for a later fenced claim, never authorization.
 */
export async function inspectLegacyModelClaimSource(input: {
  expectedUid: number
  assertSourceQuiescent(signal?: AbortSignal): Promise<void>
  signal?: AbortSignal
  /** Fixture seam only; production must omit it. */
  _testOwnerHome?: string
}): Promise<LegacyModelClaimInventory> {
  await input.assertSourceQuiescent(input.signal)
  input.signal?.throwIfAborted()
  const root = join(resolve(input._testOwnerHome ?? homedir()), '.dsh')
  const state = await ownerState(root, input.expectedUid)
  const profile = map(state.documents.find(document => document.kind === 'profile')?.value)
  const sourceDigest = profile.legacyWithheldSourceDigest
  if (typeof sourceDigest !== 'string') throw new Error('legacy_migration_source_schema_unsupported')
  const settings = map(await ownerDocument(join(root, 'settings.yaml'), input.expectedUid, {}))
  const credentialStore = credentials(await ownerDocument(join(root, '.credentials.yaml'), input.expectedUid, {}))
  if (createHash('sha256').update(JSON.stringify({ settings, credentials: credentialStore })).digest('hex') !== sourceDigest) {
    throw new Error('legacy_migration_source_changed')
  }
  const candidates: Array<LegacyModelClaimCandidate & { ref?: string }> = []
  const usedRefs = new Set<string>()
  const add = (id: string, provider: string, kind: 'llm' | 'web-search', ref?: string, literal = false): void => {
    if (ref !== undefined) usedRefs.add(ref)
    candidates.push({
      id, provider, kind,
      credential: literal || ref !== undefined && credentialStore.refs[ref] !== undefined
        ? 'present' : ref === undefined ? 'none' : 'missing',
      sharedCredential: false,
      ...(ref === undefined ? {} : { ref }),
    })
  }
  const deepseek = settings['llm-deepseek']
  const deepseekRef = deepseek === undefined ? 'DEEPSEEK_API_KEY' : map(deepseek).apiKeyEnv ?? 'DEEPSEEK_API_KEY'
  if (typeof deepseekRef !== 'string' || !REF.test(deepseekRef)) {
    throw new Error('legacy_migration_source_schema_unsupported')
  }
  if (deepseek !== undefined || credentialStore.refs[deepseekRef] !== undefined) {
    add('llm-deepseek:deepseek', 'deepseek', 'llm', deepseekRef)
  }
  let unsupportedSettings = 0
  const pi = settings['llm-pi-ai']
  if (pi !== undefined) {
    const providers = map(map(pi).providers ?? {})
    for (const [provider, value] of Object.entries(providers)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(provider)) { unsupportedSettings++; continue }
      const ref = map(value).apiKeyEnv
      if (ref !== undefined && (typeof ref !== 'string' || !REF.test(ref))) {
        throw new Error('legacy_migration_source_schema_unsupported')
      }
      add(`llm-pi-ai:${provider}`, provider, 'llm', ref)
    }
  }
  const search = settings['web-search-deepseek']
  if (search !== undefined) {
    const source = map(search)
    const ref = source.apiKeyEnv ?? 'DEEPSEEK_API_KEY'
    if (typeof ref !== 'string' || !REF.test(ref)) throw new Error('legacy_migration_source_schema_unsupported')
    const literal = typeof source.apiKey === 'string' && source.apiKey.length > 0
    add('web-search-deepseek:deepseek', 'deepseek', 'web-search', literal ? undefined : ref, literal)
  }
  for (const name of Object.keys(settings)) {
    if (!['llm-deepseek', 'llm-pi-ai', 'web-search-deepseek', 'agent-default-model',
      'agent-loop', 'permission', 'shell', 'ui-onboarding'].includes(name)) {
      unsupportedSettings++
    }
  }
  const refCounts = new Map<string, number>()
  for (const candidate of candidates) {
    if (candidate.ref !== undefined) refCounts.set(candidate.ref, (refCounts.get(candidate.ref) ?? 0) + 1)
  }
  return {
    sourceDigest,
    candidates: candidates.map(({ ref, ...candidate }) => ({
      ...candidate,
      sharedCredential: ref !== undefined && (refCounts.get(ref) ?? 0) > 1,
    })),
    unsupportedSettings,
    unassignedCredentialReferences: Object.keys(credentialStore.refs).filter(ref => !usedRefs.has(ref)).length,
    unassignedCredentialRecords: Object.keys(credentialStore.records).length,
  }
}

async function ownerState(root: string, uid: number): Promise<MigrationOwnerStateBundle> {
  await ownerDirectory(root, uid)
  const rootEntries = await readdir(root, { withFileTypes: true })
  for (const entry of rootEntries) {
    const admitted = entry.name === 'sessions' && entry.isDirectory()
      || entry.name === 'storages' && entry.isDirectory()
      || entry.name === 'profiles' && entry.isDirectory()
      || entry.name === 'host' && entry.isDirectory()
      || ['settings.yaml', '.credentials.yaml', '.anonymous-user-id', 'package.json', 'cordis.yml', 'pnpm-workspace.yaml']
        .includes(entry.name) && entry.isFile()
    if (!admitted || entry.isSymbolicLink()) throw new Error('legacy_migration_source_unknown_entry')
    if (entry.isDirectory() && entry.name !== 'sessions') await ownerDirectory(join(root, entry.name), uid)
  }
  const anonymousId = await ownerDocument(join(root, '.anonymous-user-id'), uid, null, false)
  if (anonymousId !== null && (typeof anonymousId !== 'string' || !UUID.test(anonymousId.trim()))) {
    throw new Error('legacy_migration_source_schema_unsupported')
  }
  for (const runtimeFile of ['package.json', 'cordis.yml', 'pnpm-workspace.yaml']) {
    const value = await ownerDocument(join(root, runtimeFile), uid, null, false)
    if (value !== null) jsonValue(value)
  }
  const profiles = join(root, 'profiles')
  try {
    const entries = await readdir(profiles, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' && entry.isDirectory() && !entry.isSymbolicLink()) {
        await ownerDirectory(join(profiles, entry.name), uid)
        continue
      }
      if (entry.name !== 'web' || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error('legacy_migration_source_custom_profile')
      }
      const web = join(profiles, 'web')
      await ownerDirectory(web, uid)
      const names = (await readdir(web)).sort()
      if (JSON.stringify(names) !== JSON.stringify(['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml'])) {
        throw new Error('legacy_migration_source_custom_profile')
      }
      const manifest = map(await ownerDocument(join(web, 'package.json'), uid, {}, false))
      const dependencies = map(manifest.dependencies ?? {})
      const profile = map(map(manifest.dsh).profile)
      const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
      if ((profile.patchReload !== undefined && profile.patchReload !== 'live')
        || JSON.stringify(profile.bundles) !== JSON.stringify(bundles)
        || Object.entries(dependencies).some(([name, version]) => !bundles.includes(name) || typeof version !== 'string')) {
        throw new Error('legacy_migration_source_custom_profile')
      }
      const patch = await ownerDocument(join(web, 'cordis.patch.yml'), uid, [], false)
      if (!Array.isArray(patch) || patch.length > 0) throw new Error('legacy_migration_source_custom_profile')
      const cordis = await ownerDocument(join(web, 'cordis.yml'), uid, [], false)
      if (!Array.isArray(cordis)) throw new Error('legacy_migration_source_custom_profile')
      const workspaceConfig = map(await ownerDocument(join(web, 'pnpm-workspace.yaml'), uid, {}, false))
      if (!Array.isArray(workspaceConfig.packages) || JSON.stringify(workspaceConfig.packages) !== JSON.stringify(['.'])) {
        throw new Error('legacy_migration_source_custom_profile')
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const settings = map(await ownerDocument(join(root, 'settings.yaml'), uid, {}))
  jsonValue(settings)
  if ('externalConnections' in settings) throw new Error('legacy_migration_source_schema_unsupported')
  // The legacy home belongs to the OS user, not the authenticated Person Profile.
  // Legacy settings have no account owner. Even permission and onboarding
  // state would change the first account's behavior without its consent.
  const legacyCredentials = credentials(await ownerDocument(join(root, '.credentials.yaml'), uid, {}))
  const legacyWithheldSourceDigest = createHash('sha256')
    .update(JSON.stringify({ settings, credentials: legacyCredentials }))
    .digest('hex')
  let workspace: Record<string, unknown> = { grants: [] }
  try {
    const storageEntries = await readdir(join(root, 'storages'))
    if (storageEntries.some(name => !['workspace.json', 'session_projcache.json'].includes(name))) {
      throw new Error('legacy_migration_source_unknown_entry')
    }
    if (storageEntries.includes('session_projcache.json')) {
      jsonValue(await ownerDocument(join(root, 'storages', 'session_projcache.json'), uid, {}))
    }
    if (storageEntries.includes('workspace.json')) {
      const storage = map(await ownerDocument(join(root, 'storages', 'workspace.json'), uid, {}))
      const unit = map(storage.unit)
      const tables = map(storage.tables)
      const records = map(tables.workspaces ?? {})
      if (unit.name !== 'workspace' || unit.version !== 2) {
        throw new Error('legacy_migration_source_schema_unsupported')
      }
      const grants = Object.values(records).map(record => map(record).path)
      if (grants.some(path => typeof path !== 'string' || !path.startsWith('/'))) {
        throw new Error('legacy_migration_source_schema_unsupported')
      }
      jsonValue(storage)
      workspace = { grants: [...new Set(grants as string[])].sort(), storage }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return {
    version: 1,
    documents: [
      { kind: 'settings', schemaVersion: 1, value: {} },
      { kind: 'credentials', schemaVersion: 1, value: { refs: {}, records: {} } },
      { kind: 'workspace', schemaVersion: 1, value: workspace },
      { kind: 'profile', schemaVersion: 1, value: {
        name: 'web', customPlugins: [], externalConnections: [], legacyWithheldSourceDigest,
      } },
    ],
  }
}

/**
 * Create an owner-only, zero-write source over the fixed `${HOME}/.dsh` legacy layout.
 * @param input - owner identity, quiescence guard, and owner-only transfer sink.
 * @returns bounded migration exporter for the legacy source.
 */
export function createLegacyMigrationExportService(input: {
  expectedUid: number
  assertSourceQuiescent(signal?: AbortSignal): Promise<void>
  stageOwnerTransfer(bundle: MigrationOwnerTransferBundle, signal?: AbortSignal): Promise<{
    transferId: string
    transferDigest: string
  }>
  now?: () => number
  /** Fixture seam only; production must omit it. */
  _testOwnerHome?: string
}): JsonlMigrationExportService {
  const ownerHome = resolve(input._testOwnerHome ?? homedir())
  const root = join(ownerHome, '.dsh')
  const source = new FileJsonlMigrationExportSource(join(root, 'sessions'), input.expectedUid, {
    read: () => ownerState(root, input.expectedUid),
  })
  return new JsonlMigrationExportService(source, {
    assertQuiescent: signal => input.assertSourceQuiescent(signal),
    stageOwnerTransfer: (bundle, signal) => input.stageOwnerTransfer(bundle, signal),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}
