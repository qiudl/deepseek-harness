import { createHash, randomUUID } from 'node:crypto'
import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  FileOwnerJsonlMigrationGenerationTarget,
  FileOwnerMigrationImportJournal,
  FileOwnerMigrationTransferStore,
  OwnerMigrationImportService,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-import.ts'
import {
  JsonlMigrationExportService,
  type MigrationOwnerStateBundle,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export.ts'
import {
  FileJsonlMigrationExportSource,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/migration-export-source.ts'
import { DesktopHost } from './desktop-host.ts'
import { DshAccountAccessTokenVerifier } from './account-access-token.ts'
import { CurrentMigrationExportService } from './current-migration-export.ts'
import { DshWebProfileWorkerFactory } from './dsh-web-profile-worker.ts'
import { createLegacyMigrationExportService } from './legacy-migration-source.ts'
import { createMacOSPeerAttestor } from './macos-peer-attestor.ts'
import { ProfileRegistry } from './profile-registry.ts'
import { MigrationOwnerStateApplicator } from './migration-owner-state-applicator.ts'
import { MaterializedMigrationOwnerStateSource } from './materialized-migration-owner-state-source.ts'
import { RestartingMigrationTarget } from './restarting-migration-target.ts'
import { FileHostJournal, SessionCommandAuthority } from './session-command.ts'
import { acquireSingleHostLock, type SingleHostLock } from './single-instance.ts'
import type { HostClock, PersonProfileRecord } from './types.ts'
import { HostAuthorityError } from './types.ts'
import { UnixHostServer } from './unix-transport.ts'
import { ProfileWorkerSupervisor } from './worker-supervisor.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-host-startup'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const EMPTY_OWNER_STATE: MigrationOwnerStateBundle = Object.freeze({
  version: 1,
  documents: Object.freeze([
    Object.freeze({ kind: 'settings' as const, schemaVersion: 1, value: Object.freeze({}) }),
    Object.freeze({
      kind: 'credentials' as const,
      schemaVersion: 1,
      value: Object.freeze({ refs: Object.freeze({}), records: Object.freeze({}) }),
    }),
    Object.freeze({
      kind: 'workspace' as const,
      schemaVersion: 1,
      value: Object.freeze({ grants: Object.freeze([]) }),
    }),
    Object.freeze({
      kind: 'profile' as const,
      schemaVersion: 1,
      value: Object.freeze({ name: 'web', customPlugins: Object.freeze([]) }),
    }),
  ]),
})

/** Desktop Host application configuration supplied by the macOS embedding. */
export interface Config {
  readonly root?: string
  readonly registrationRoot?: string
  readonly nodeExecutablePath: string
  readonly dshEntrypointPath: string
  readonly deviceIndexKeyPath: string
  readonly accountKeyringPath: string
  readonly accountKeyringSha256: string
  readonly installationPrivateKeyPath: string
  readonly installationPublicKey: string
  readonly installationId: string
  readonly endpointRegistrationId: string
  readonly hostInstanceId: string
  readonly processNonce: string
  readonly executableSignatureDigest: string
  readonly desktopTeamIdentifiers: string[]
  readonly desktopExecutableDigests: string[]
  readonly runtimeGeneration: number
  readonly schemaGeneration: number
  readonly legacySourceQuiescent?: boolean
}

/** Validate the fail-closed startup settings resolved from the shipped profile patch. */
export const Config: z<Config> = z.object({
  root: z.string(),
  registrationRoot: z.string(),
  nodeExecutablePath: z.string().required(),
  dshEntrypointPath: z.string().required(),
  deviceIndexKeyPath: z.string().required(),
  accountKeyringPath: z.string().required(),
  accountKeyringSha256: z.string().required(),
  installationPrivateKeyPath: z.string().required(),
  installationPublicKey: z.string().required(),
  installationId: z.string().required(),
  endpointRegistrationId: z.string().required(),
  hostInstanceId: z.string().required(),
  processNonce: z.string().required(),
  executableSignatureDigest: z.string().required(),
  desktopTeamIdentifiers: z.array(String).required(),
  desktopExecutableDigests: z.array(String).required(),
  runtimeGeneration: z.number().required(),
  schemaGeneration: z.number().required(),
  legacySourceQuiescent: z.boolean(),
})

/** Running owner composition; close reaches listener, worker, and lock quiescence. */
export interface DesktopHostApplication {
  readonly host: DesktopHost
  readonly server: UnixHostServer
  readonly workers: ProfileWorkerSupervisor
  readonly commandAuthority: SessionCommandAuthority
  close(): Promise<void>
}

function ownerFile(path: string, expectedBytes?: number): Buffer {
  if (!isAbsolute(path)) throw new HostAuthorityError('invalid_input')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    const uid = process.getuid?.() ?? stat.uid
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0
      || (expectedBytes !== undefined && stat.size !== expectedBytes)) throw new HostAuthorityError('unavailable')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

function pinnedOwnerFile(path: string, expectedSha256: string): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new HostAuthorityError('invalid_input')
  const contents = ownerFile(path)
  if (contents.length < 1 || contents.length > 16 * 1024
    || createHash('sha256').update(contents).digest('hex') !== expectedSha256) {
    throw new HostAuthorityError('unavailable')
  }
  return contents
}

function executableArtifact(path: string, uid: number): void {
  if (!isAbsolute(path)) throw new HostAuthorityError('invalid_input')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
  } finally { closeSync(fd) }
}

function ownerDirectory(path: string, uid: number): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new HostAuthorityError('unavailable')
  }
}

function ownerContainerDirectory(path: string, uid: number): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new HostAuthorityError('unavailable')
  }
}

function replaceOwnerFile(path: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeSync(fd, contents); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
}

function publishRegistration(config: Config, socketPath: string, uid: number): void {
  if (!UUID.test(config.endpointRegistrationId)) throw new HostAuthorityError('invalid_input')
  const registrationRoot = config.registrationRoot ?? join(homedir(), '.dsh', 'host')
  if (!isAbsolute(registrationRoot)) throw new HostAuthorityError('invalid_input')
  ownerContainerDirectory(join(registrationRoot, '..'), uid)
  ownerDirectory(registrationRoot, uid)
  const path = join(registrationRoot, 'registration.v1.json')
  const registration = {
    schema_version: 1,
    endpoint_registration_id: config.endpointRegistrationId,
    socket_path: socketPath,
    installation_id: config.installationId,
    installation_public_key: config.installationPublicKey,
    executable_signature_digest: config.executableSignatureDigest,
  }
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new HostAuthorityError('unavailable')
    }
    let existing: unknown
    try { existing = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new HostAuthorityError('unavailable') }
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      throw new HostAuthorityError('unavailable')
    }
    const record = existing as Record<string, unknown>
    const keys = Object.keys(registration).sort()
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(keys)
      || keys.some(key => record[key] !== registration[key as keyof typeof registration])) {
      throw new HostAuthorityError('conflict')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  replaceOwnerFile(path, `${JSON.stringify(registration)}\n`)
}

/**
 * Assemble and start the single macOS Host authority and every unlocked Profile worker.
 * @param config - embedding-owned paths, identities, signing policy, and generations.
 * @param clock - optional deterministic clock for integration tests.
 * @returns running application whose control journal has exactly one writer authority.
 */
export async function startDesktopHostApplication(config: Config, clock: HostClock = { now: Date.now }): Promise<DesktopHostApplication> {
  if (process.platform !== 'darwin') throw new HostAuthorityError('unavailable')
  const root = config.root ?? join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness Host')
  if (!isAbsolute(root) || !isAbsolute(config.nodeExecutablePath) || !isAbsolute(config.dshEntrypointPath)) {
    throw new HostAuthorityError('invalid_input')
  }
  const uid = process.getuid?.()
  if (uid === undefined) throw new HostAuthorityError('unavailable')
  ownerDirectory(root, uid)
  let ownership: SingleHostLock | undefined
  let server: UnixHostServer | undefined
  executableArtifact(config.nodeExecutablePath, uid)
  executableArtifact(config.dshEntrypointPath, uid)
  const workerFactory = new DshWebProfileWorkerFactory({
    nodeExecutablePath: config.nodeExecutablePath, dshEntrypointPath: config.dshEntrypointPath,
  })
  const workers = new ProfileWorkerSupervisor(spec => workerFactory.create(spec))
  try {
    ownership = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: config.processNonce })
    const registry = new ProfileRegistry({
      root: join(root, 'registry'), deviceIndexKey: ownerFile(config.deviceIndexKeyPath, 32), clock,
    })
    const accountAccessVerifier = new DshAccountAccessTokenVerifier(
      pinnedOwnerFile(config.accountKeyringPath, config.accountKeyringSha256).toString('utf8'),
      { now: () => clock.now() },
    )
    const migrationRoot = join(root, 'migration')
    ownerDirectory(migrationRoot, uid)
    const transferStore = new FileOwnerMigrationTransferStore(join(migrationRoot, 'transfers'), uid)
    const targets = new Map<string, FileOwnerJsonlMigrationGenerationTarget>()
    const ownerStateApplicator = new MigrationOwnerStateApplicator(uid)
    const targetFor = (profileId: string): FileOwnerJsonlMigrationGenerationTarget => {
      const existing = targets.get(profileId)
      if (existing) return existing
      const target = new FileOwnerJsonlMigrationGenerationTarget(
        join(root, 'profiles', profileId, 'persistence'), uid, config.schemaGeneration,
      )
      targets.set(profileId, target)
      return target
    }
    const ensureWorker = async (profile: PersonProfileRecord): Promise<void> => {
      const profilesRoot = join(root, 'profiles')
      ownerDirectory(profilesRoot, uid)
      const profileRoot = join(profilesRoot, profile.profileId)
      ownerDirectory(profileRoot, uid)
      const target = targetFor(profile.profileId)
      const persistence = await target.activePersistenceConfig()
      let ownerState: MigrationOwnerStateBundle
      try {
        ownerState = await target.activeOwnerState()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try {
          await target.importOwnerState(persistence.generation, EMPTY_OWNER_STATE)
        } catch (publishError) {
          if ((publishError as NodeJS.ErrnoException).code !== 'EEXIST') throw publishError
        }
        ownerState = await target.activeOwnerState()
      }
      const ownerPaths = await ownerStateApplicator.apply(profileRoot, persistence.generation, ownerState)
      const patch = [
        '- id: session-persistence-jsonl',
        '  config:',
        `    root: ${JSON.stringify(persistence.root)}`,
        '    compression: none',
      ]
      patch.push(
        '- id: storage-json',
        '  config:',
        `    root: ${JSON.stringify(ownerPaths.storageRoot)}`,
        '- id: settings',
        '  config:',
        `    path: ${JSON.stringify(ownerPaths.settingsPath)}`,
        `    dshHome: ${JSON.stringify(profileRoot)}`,
        '    watch: false',
        '- id: credentials',
        '  config:',
        `    path: ${JSON.stringify(ownerPaths.credentialsPath)}`,
        `    dshHome: ${JSON.stringify(profileRoot)}`,
        '    watch: false',
      )
      replaceOwnerFile(join(profileRoot, 'cordis.patch.yml'), `${patch.join('\n')}\n`)
      await workers.ensure({
        profileId: profile.profileId, profileRoot, credentialHandle: profile.keyHandle,
        pluginRoots: [join(profileRoot, 'plugins')],
      })
    }
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: config.runtimeGeneration,
      verifyAccountAccessToken: token => accountAccessVerifier.verify(token),
      activateProfileView: profileId => workers.activate(profileId),
      ensureProfileWorker: ensureWorker,
    })
    const journal = new FileHostJournal(join(root, 'control', 'commands.jsonl'))
    const commandAuthority = new SessionCommandAuthority(journal, clock)
    const imports = new Map<string, OwnerMigrationImportService>()
    const socketPath = join(root, 'host.sock')
    server = new UnixHostServer({
      socketPath, ownership, expectedUid: uid,
      allowedDesktopExecutableDigests: new Set(config.desktopExecutableDigests),
      attestPeer: createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(config.desktopTeamIdentifiers) }),
      identity: {
        hostInstanceId: config.hostInstanceId, installationId: config.installationId,
        installationPublicKey: config.installationPublicKey,
        installationPrivateKey: ownerFile(config.installationPrivateKeyPath),
        processNonce: config.processNonce, executableSignatureDigest: config.executableSignatureDigest,
        runtimeGeneration: config.runtimeGeneration, schemaGeneration: config.schemaGeneration,
        hostGeneration: ownership.hostGeneration,
      },
      host,
      profilePersistenceGeneration: async profileId => (await targetFor(profileId).activePersistenceConfig()).generation,
      ...(config.legacySourceQuiescent === true ? {
        createLegacyMigrationExport: () => createLegacyMigrationExportService({
          expectedUid: uid,
          assertSourceQuiescent: () => Promise.resolve(),
          now: () => clock.now(),
          stageOwnerTransfer: async (bundle, signal) => {
            signal?.throwIfAborted()
            const receipt = await transferStore.stage(bundle)
            signal?.throwIfAborted()
            return receipt
          },
        }),
      } : {}),
      createMigrationExport: (_ownerId, profileId) => {
        const profile = registry.resolveProfile(profileId as never)
        if (!profile) throw new HostAuthorityError('stale')
        const currentExporter = async (): Promise<JsonlMigrationExportService> => {
          const target = targetFor(profileId)
          const active = await target.activePersistenceConfig()
          const profileRoot = join(root, 'profiles', profileId)
          ownerDirectory(profileRoot, uid)
          const ownerPaths = await ownerStateApplicator.apply(
            profileRoot, active.generation, await target.activeOwnerState(),
          )
          const liveOwnerState = new MaterializedMigrationOwnerStateSource(ownerPaths, uid)
          const source = new FileJsonlMigrationExportSource(active.root, uid, {
            read: () => liveOwnerState.read(),
          })
          return new JsonlMigrationExportService(source, {
            assertQuiescent: () => Promise.resolve(),
            now: () => clock.now(),
            stageOwnerTransfer: async (bundle, signal) => {
              signal?.throwIfAborted()
              const receipt = await transferStore.stage(bundle)
              signal?.throwIfAborted()
              return receipt
            },
          })
        }
        const quiesced = async <T>(operation: () => Promise<T>): Promise<T> => {
          host.revokeProfile(profile.profileId)
          await workers.dispose(profileId)
          try { return await operation() } finally { await ensureWorker(profile) }
        }
        return new CurrentMigrationExportService(currentExporter, quiesced)
      },
      createMigrationImport: (_ownerId, profileId) => {
        let migrationImport = imports.get(profileId)
        if (!migrationImport) {
          const target = targetFor(profileId)
          const restartingTarget = new RestartingMigrationTarget(target, async () => {
            const profile = registry.resolveProfile(profileId as never)
            if (!profile) throw new HostAuthorityError('stale')
            host.revokeProfile(profile.profileId)
            await workers.dispose(profileId)
            await ensureWorker(profile)
          })
          migrationImport = new OwnerMigrationImportService(
            transferStore, restartingTarget,
            new FileOwnerMigrationImportJournal(join(root, 'profiles', profileId, 'migration-journal'), uid),
          )
          imports.set(profileId, migrationImport)
        }
        return {
          stage: input => migrationImport.stage({
            transferId: input.transferId, transferDigest: input.transferDigest,
            sourceInstallationId: input.sourceInstallationId,
            sourceInventoryDigest: input.sourceInventoryDigest,
            targetProfileSelectorHash: input.targetProfileSelectorHash,
            sourceGeneration: input.sourceGeneration, sourceSchemaVersion: input.sourceSchemaVersion,
            targetGeneration: input.targetGeneration, recordCount: input.recordCount,
            semanticDigest: input.semanticDigest,
          }),
          status: input => migrationImport.status(input),
          verify: (importId, expectedVersion) => migrationImport.verify(importId, expectedVersion),
          commit: (importId, expectedVersion, expectedCurrentGeneration) => migrationImport.commit(
            importId, expectedVersion, expectedCurrentGeneration,
          ),
          abort: (importId, expectedVersion) => migrationImport.abort(importId, expectedVersion),
        }
      },
    })
    await server.start()
    publishRegistration(config, socketPath, uid)
    let closed = false
    return {
      host, server, workers, commandAuthority,
      async close() {
        if (closed) return
        closed = true
        await server?.close()
        await workers.disposeAll()
        await ownership?.release()
      },
    }
  } catch (error) {
    await server?.close().catch(() => undefined)
    await workers.disposeAll().catch(() => undefined)
    await ownership?.release().catch(() => undefined)
    throw error
  }
}

/** Start and dispose the application with its Cordis profile lifecycle. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.effect(async () => {
    const application = await startDesktopHostApplication(config)
    return () => application.close()
  })
}
