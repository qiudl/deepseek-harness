import { createHash, randomUUID } from 'node:crypto'
import {
  constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync,
} from 'node:fs'
import { existsSync } from 'node:fs'
import { loadProfileDirectory, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { homedir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
export { loadWindowsLocalProfileStorage, loadWindowsLegacySourceProbe } from './windows-local-profile-storage-native.ts'
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
import { FileExtensionReceipts, ProfileExtensionOperations } from './extension-operations.ts'
import { ProfileMcpExecutor } from './profile-mcp-executor.ts'
import { ProfileSkillExecutor } from './profile-skill-executor.ts'
import { ProfilePluginExecutor } from './profile-plugin-executor.ts'
import { runProfilePluginCommand } from './plugin-command.ts'
import { inspectPluginScripts } from './plugin-script-preflight.ts'
import { planPluginToggle } from './plugin-toggle-plan.ts'
import { pluginBundleEntries } from './plugin-bundle-entries.ts'
import { waitForPluginRuntime } from './plugin-runtime-ack.ts'
import { ProfileExtensionExecutor } from './profile-extension-executor.ts'
import { readProfileSkillCatalog, readProfileSkillRuntime } from './skill-worker-client.ts'
import { reloadProfileMcpRuntime } from './mcp-runtime-ack.ts'
import { DesktopHost } from './desktop-host.ts'
import { DshAccountAccessTokenVerifier } from './account-access-token.ts'
import { CurrentMigrationExportService } from './current-migration-export.ts'
import { DshWebProfileWorkerFactory } from './dsh-web-profile-worker.ts'
import { createLegacyMigrationExportService, inspectLegacyModelClaimSource, readLegacyModelClaimDocuments } from './legacy-migration-source.ts'
import { FileProfileClaimMarkerFiles, ProfileClaimMarker } from './legacy-claim-marker.ts'
import { LegacyClaimWorkerGate } from './legacy-claim-worker-gate.ts'
import { LegacyClaimCoordinator } from './legacy-claim-coordinator.ts'
import { LegacyClaimLedger } from './legacy-claim-ledger.ts'
import { FileLegacyClaimEventStore } from './legacy-claim-store.ts'
import { LegacyClaimRecoveryStore } from './legacy-claim-recovery.ts'
import { FileLegacyClaimRecoveryFiles } from './legacy-claim-recovery-files.ts'
import { LegacyClaimTarget } from './legacy-claim-target.ts'
import { FileLegacyClaimTargetFiles } from './legacy-claim-target-files.ts'
import { createMacOSPeerAttestor } from './macos-peer-attestor.ts'
import { ProfileRegistry } from './profile-registry.ts'
import { MigrationOwnerStateApplicator } from './migration-owner-state-applicator.ts'
import { MaterializedMigrationOwnerStateSource } from './materialized-migration-owner-state-source.ts'
import { existingProfilePatch, OfflineProfileRecoveryInspector, packagedRuntimeAppRoot } from './offline-profile-recovery.ts'
import { RestartingMigrationTarget } from './restarting-migration-target.ts'
import { FileHostJournal, SessionCommandAuthority } from './session-command.ts'
import { acquireSingleHostLock, type SingleHostLock } from './single-instance.ts'
import type { HostClock, PersonProfileRecord, ProfileWorkerFactory } from './types.ts'
import { HostAuthorityError } from './types.ts'
import {
  UnixHostServer,
  type UnixHostServerOptions,
  type UnixPeerAttestor,
} from './unix-transport.ts'
import { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import {
  startWindowsDesktopHostApplicationFromPrivateFiles,
  type WindowsDesktopHostApplication,
  type WindowsDesktopHostPrivateFileConfig,
} from './windows-startup.ts'

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

/** Desktop Host application configuration supplied by the signed embedding. */
export interface Config {
  readonly root?: string
  readonly registrationRoot?: string
  readonly nodeExecutablePath: string
  readonly dshEntrypointPath: string
  readonly pnpmEntrypointPath?: string
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
  readonly desktopPublisherThumbprints?: string[]
  readonly windowsWorkerEntryPath?: string
  readonly windowsNativeModulePath?: string
  readonly windowsNativeModuleSha256?: string
  readonly windowsWorkerGeneration?: number
  readonly windowsMaxCancelAttempts?: number
  readonly windowsCancelRetryMs?: number
  readonly windowsStartupTimeoutMs?: number
  readonly windowsExitTimeoutMs?: number
  readonly windowsSessionCleanupTimeoutMs?: number
  readonly windowsMaximumRegistryBytes?: number
  readonly windowsMaximumManagedFileBytes?: number
  readonly windowsMaximumJournalBytes?: number
  readonly windowsProfileReadyTimeoutMs?: number
  readonly windowsProfileAbortTimeoutMs?: number
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
  pnpmEntrypointPath: z.string(),
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
  desktopPublisherThumbprints: z.array(String),
  windowsWorkerEntryPath: z.string(),
  windowsNativeModulePath: z.string(),
  windowsNativeModuleSha256: z.string(),
  windowsWorkerGeneration: z.number(),
  windowsMaxCancelAttempts: z.number(),
  windowsCancelRetryMs: z.number(),
  windowsStartupTimeoutMs: z.number(),
  windowsExitTimeoutMs: z.number(),
  windowsSessionCleanupTimeoutMs: z.number(),
  windowsMaximumRegistryBytes: z.number(),
  windowsMaximumManagedFileBytes: z.number(),
  windowsMaximumJournalBytes: z.number(),
  windowsProfileReadyTimeoutMs: z.number(),
  windowsProfileAbortTimeoutMs: z.number(),
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

/**
 * Startup adapters used to exercise the owner composition without platform-native processes.
 * @internal
 */
export interface StartDesktopHostApplicationDependencies {
  readonly platform?: NodeJS.Platform
  readonly profileWorkerFactory?: ProfileWorkerFactory
  readonly attestPeer?: UnixPeerAttestor
  readonly createServer?: (options: UnixHostServerOptions) => UnixHostServer
}

interface ClosableDesktopHostApplication {
  close(): Promise<void>
}

const WINDOWS_DEFAULTS = Object.freeze({
  workerGeneration: 1,
  maxCancelAttempts: 4,
  cancelRetryMs: 250,
  startupTimeoutMs: 30_000,
  exitTimeoutMs: 5_000,
  sessionCleanupTimeoutMs: 5_000,
  maximumRegistryBytes: 1024 * 1024,
  maximumManagedFileBytes: 256 * 1024,
  maximumJournalBytes: 8 * 1024 * 1024,
  profileReadyTimeoutMs: 30_000,
  profileAbortTimeoutMs: 5_000,
})

function boundedInteger(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new HostAuthorityError('invalid_input')
  return resolved
}

function deadlineAfter(milliseconds: number): (signal: AbortSignal) => Promise<void> {
  return signal => new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

function windowsFileUrl(path: string): URL {
  if (!/^[A-Za-z]:\\/u.test(path) || path.slice(2).includes(':')
    || /[\u0000-\u001f\u007f]/u.test(path) || win32.normalize(path) !== path) {
    throw new HostAuthorityError('invalid_input')
  }
  return pathToFileURL(path, { windows: true })
}

/**
 * Translate secret-free Cordis settings into the locked Windows Host composition.
 * @param config - Cordis settings with explicit private roots and a canonical Worker path.
 * @returns Windows configuration; rejects missing paths or invalid timeout bounds before startup.
 */
export function windowsDesktopHostConfig(config: Config): WindowsDesktopHostPrivateFileConfig {
  if (config.root === undefined || config.registrationRoot === undefined
    || config.windowsWorkerEntryPath === undefined || config.windowsNativeModulePath === undefined
    || config.windowsNativeModuleSha256 === undefined) throw new HostAuthorityError('invalid_input')
  const retryMs = boundedInteger(config.windowsCancelRetryMs, WINDOWS_DEFAULTS.cancelRetryMs)
  const startupMs = boundedInteger(config.windowsStartupTimeoutMs, WINDOWS_DEFAULTS.startupTimeoutMs)
  const exitMs = boundedInteger(config.windowsExitTimeoutMs, WINDOWS_DEFAULTS.exitTimeoutMs)
  const cleanupMs = boundedInteger(
    config.windowsSessionCleanupTimeoutMs,
    WINDOWS_DEFAULTS.sessionCleanupTimeoutMs,
  )
  return {
    platform: 'win32',
    arch: 'x64',
    root: config.root,
    registrationRoot: config.registrationRoot,
    nodeExecutablePath: config.nodeExecutablePath,
    dshEntrypointPath: config.dshEntrypointPath,
    deviceIndexKeyPath: config.deviceIndexKeyPath,
    accountKeyringPath: config.accountKeyringPath,
    accountKeyringSha256: config.accountKeyringSha256,
    installationPrivateKeyPath: config.installationPrivateKeyPath,
    installationPublicKey: config.installationPublicKey,
    installationId: config.installationId,
    endpointRegistrationId: config.endpointRegistrationId,
    hostInstanceId: config.hostInstanceId,
    processNonce: config.processNonce,
    executableSignatureDigest: config.executableSignatureDigest,
    runtimeGeneration: config.runtimeGeneration,
    schemaGeneration: config.schemaGeneration,
    workerEntry: windowsFileUrl(config.windowsWorkerEntryPath),
    nativeModule: {
      path: config.windowsNativeModulePath,
      sha256: config.windowsNativeModuleSha256,
    },
    workerGeneration: boundedInteger(config.windowsWorkerGeneration, WINDOWS_DEFAULTS.workerGeneration),
    allowedPublisherThumbprints: new Set(config.desktopPublisherThumbprints ?? []),
    allowedDesktopExecutableDigests: new Set(config.desktopExecutableDigests),
    maximumRegistryBytes: boundedInteger(
      config.windowsMaximumRegistryBytes,
      WINDOWS_DEFAULTS.maximumRegistryBytes,
    ),
    maximumManagedFileBytes: boundedInteger(
      config.windowsMaximumManagedFileBytes,
      WINDOWS_DEFAULTS.maximumManagedFileBytes,
    ),
    maximumJournalBytes: boundedInteger(
      config.windowsMaximumJournalBytes,
      WINDOWS_DEFAULTS.maximumJournalBytes,
    ),
    profileReadyTimeoutMs: boundedInteger(
      config.windowsProfileReadyTimeoutMs,
      WINDOWS_DEFAULTS.profileReadyTimeoutMs,
    ),
    profileAbortTimeoutMs: boundedInteger(
      config.windowsProfileAbortTimeoutMs,
      WINDOWS_DEFAULTS.profileAbortTimeoutMs,
    ),
    maxCancelAttempts: boundedInteger(config.windowsMaxCancelAttempts, WINDOWS_DEFAULTS.maxCancelAttempts),
    waitForCancelRetry: () => new Promise((resolve) => { setTimeout(resolve, retryMs) }),
    startupDeadline: deadlineAfter(startupMs),
    exitWithoutHandleDeadline: deadlineAfter(exitMs),
    sessionCleanupDeadline: deadlineAfter(cleanupMs),
    processFallback: () => {
      process.kill(process.pid, 'SIGKILL')
      throw new HostAuthorityError('unavailable')
    },
  }
}

function ownerFile(path: string, uid: number, expectedBytes?: number): Buffer {
  if (!isAbsolute(path)) throw new HostAuthorityError('invalid_input')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0
      || (expectedBytes !== undefined && stat.size !== expectedBytes)) throw new HostAuthorityError('unavailable')
    return readFileSync(fd)
  } finally { closeSync(fd) }
}

function pinnedOwnerFile(path: string, uid: number, expectedSha256: string): Buffer {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new HostAuthorityError('invalid_input')
  const contents = ownerFile(path, uid)
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
      || keys.some(key => key !== 'executable_signature_digest'
        && record[key] !== registration[key as keyof typeof registration])) {
      throw new HostAuthorityError('conflict')
    }
    if (typeof record.executable_signature_digest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(record.executable_signature_digest)) {
      throw new HostAuthorityError('unavailable')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  replaceOwnerFile(path, `${JSON.stringify(registration)}\n`)
}

function requiredProfile(registry: ProfileRegistry, profileId: string): PersonProfileRecord {
  const profile = registry.resolveProfile(profileId as never)
  if (!profile) throw new HostAuthorityError('stale')
  return profile
}

/**
 * Assemble and start the single macOS Host authority and every unlocked Profile worker.
 * @param config - embedding-owned paths, identities, signing policy, and generations.
 * @param clock - optional deterministic clock for integration tests.
 * @param dependencies - optional platform-native boundaries for composition verification.
 * @returns running application whose control journal has exactly one writer authority.
 */
export async function startDesktopHostApplication(
  config: Config,
  clock: HostClock = { now: Date.now },
  dependencies: StartDesktopHostApplicationDependencies = {},
): Promise<DesktopHostApplication> {
  if ((dependencies.platform ?? process.platform) !== 'darwin') throw new HostAuthorityError('unavailable')
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
  if (config.pnpmEntrypointPath !== undefined) executableArtifact(config.pnpmEntrypointPath, uid)
  const workerFactory = new DshWebProfileWorkerFactory({
    nodeExecutablePath: config.nodeExecutablePath, dshEntrypointPath: config.dshEntrypointPath,
  })
  /* v8 ignore next -- the production subprocess factory is exercised by packaged Host integration, not unit composition. */
  const workers = new ProfileWorkerSupervisor(dependencies.profileWorkerFactory ?? (spec => workerFactory.create(spec)))
  try {
    ownership = await acquireSingleHostLock({ root, pid: process.pid, uid, processNonce: config.processNonce })
    const registry = new ProfileRegistry({
      root: join(root, 'registry'), deviceIndexKey: ownerFile(config.deviceIndexKeyPath, uid, 32), clock,
    })
    const accountAccessVerifier = new DshAccountAccessTokenVerifier(
      pinnedOwnerFile(config.accountKeyringPath, uid, config.accountKeyringSha256).toString('utf8'),
      { now: () => clock.now() },
    )
    const migrationRoot = join(root, 'migration')
    ownerDirectory(migrationRoot, uid)
    const transferStore = new FileOwnerMigrationTransferStore(join(migrationRoot, 'transfers'), uid)
    const targets = new Map<string, FileOwnerJsonlMigrationGenerationTarget>()
    const ownerStateApplicator = new MigrationOwnerStateApplicator(uid)
    const claimMarker = new ProfileClaimMarker(new FileProfileClaimMarkerFiles(join(root, 'profiles'), uid))
    const claimWorkerGate = new LegacyClaimWorkerGate(profileId => claimMarker.pending(profileId))
    const targetFor = (profileId: string): FileOwnerJsonlMigrationGenerationTarget => {
      const existing = targets.get(profileId)
      if (existing) return existing
      const target = new FileOwnerJsonlMigrationGenerationTarget(
        join(root, 'profiles', profileId, 'persistence'), uid, config.schemaGeneration,
      )
      targets.set(profileId, target)
      return target
    }
    const ensureWorker = async (profile: PersonProfileRecord, claimRestart = false): Promise<void> => {
      const profilesRoot = join(root, 'profiles')
      ownerDirectory(profilesRoot, uid)
      const profileRoot = join(profilesRoot, profile.profileId)
      ownerDirectory(profileRoot, uid)
      if (claimRestart) {
        /* v8 ignore next -- the coordinator clears the marker synchronously before its restart callback. */
        if (claimMarker.pending(profile.profileId)) throw new HostAuthorityError('unavailable')
      } else claimWorkerGate.assertOpen(profile.profileId)
      const target = targetFor(profile.profileId)
      const persistence = await target.activePersistenceConfig()
      let ownerState: MigrationOwnerStateBundle
      try {
        ownerState = await target.activeOwnerState()
      } catch (error) {
        /* v8 ignore next -- non-ENOENT persistence faults are injected and verified by the generation target's owning tests. */
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        try {
          await target.importOwnerState(persistence.generation, EMPTY_OWNER_STATE)
        } catch (publishError) {
          /* v8 ignore next -- only a concurrent first-owner publication can enter this EEXIST recovery race. */
          if ((publishError as NodeJS.ErrnoException).code !== 'EEXIST') throw publishError
        }
        ownerState = await target.activeOwnerState()
      }
      const ownerPaths = await ownerStateApplicator.apply(profileRoot, persistence.generation, ownerState)
      replaceOwnerFile(join(profileRoot, 'cordis.patch.yml'), existingProfilePatch(profileRoot, persistence, ownerPaths))
      await claimWorkerGate.start(profile.profileId, () => workers.ensure({
        profileId: profile.profileId, profileRoot, credentialHandle: profile.keyHandle,
        pluginRoots: [join(profileRoot, 'plugins')],
      }),
      /* v8 ignore next -- the claim gate's startup-race test covers disposal; production workers need a real child. */
      () => workers.dispose(profile.profileId), claimRestart)
    }
    const currentRuntimeAppRoot = packagedRuntimeAppRoot(config.dshEntrypointPath)
    const recoveryInspector = new OfflineProfileRecoveryInspector({
      hostRoot: root,
      installationId: config.installationId,
      expectedUid: uid,
      ...(currentRuntimeAppRoot === undefined ? {} : { currentRuntimeAppRoot }),
      targetFor,
      ownerStateApplicator,
    })
    const inspectOfflineAccountProfile = (
      profile: PersonProfileRecord,
      expected: { readonly runtimeGeneration: number; readonly schemaGeneration: number },
    ) => recoveryInspector.inspect(profile, expected)
    const ensureRecoveredProfileWorker = async (
      profile: PersonProfileRecord,
      preflight: Awaited<ReturnType<typeof inspectOfflineAccountProfile>>,
    ): Promise<void> => {
      claimWorkerGate.assertOpen(profile.profileId)
      await recoveryInspector.prepareConfirmedProfile(profile, preflight)
      try {
        await claimWorkerGate.start(profile.profileId, () => workers.ensure({
          profileId: profile.profileId,
          profileRoot: join(root, 'profiles', profile.profileId),
          credentialHandle: profile.keyHandle,
          pluginRoots: [join(root, 'profiles', profile.profileId, 'plugins')],
        }),
        /* v8 ignore next -- the claim gate's startup-race test covers disposal; offline recovery needs packaged artifacts. */
        () => workers.dispose(profile.profileId))
        // `dsh --profile web` may refresh pnpm links to the packaged App while booting.
        // Reinspect and pin those generated links into the Profile-owned content-addressed closure
        // before returning an offline grant, so replacing the App cannot break the next launch.
        const stabilized = await recoveryInspector.inspect(profile, {
          runtimeGeneration: config.runtimeGeneration,
          schemaGeneration: config.schemaGeneration,
        })
        await recoveryInspector.prepareConfirmedProfile(profile, stabilized)
      } catch (error) {
        await workers.dispose(profile.profileId).catch(() => undefined)
        throw error
      }
    }
    const host = new DesktopHost({
      registry, clock, runtimeGeneration: config.runtimeGeneration,
      verifyAccountAccessToken: token => accountAccessVerifier.verify(token),
      activateProfileView: async (profileId) => {
        claimWorkerGate.assertOpen(profileId)
        const view = await workers.activate(profileId)
        claimWorkerGate.assertOpen(profileId)
        return view
      },
      ensureProfileWorker: ensureWorker,
      inspectOfflineAccountProfile,
      ensureRecoveredProfileWorker,
    })
    const journal = new FileHostJournal(join(root, 'control', 'commands.jsonl'))
    const commandAuthority = new SessionCommandAuthority(journal, clock)
    const imports = new Map<string, OwnerMigrationImportService>()
    const mcpExecutor = new ProfileMcpExecutor({
      uid,
      profileRoot: (profileId) => {
        requiredProfile(registry, profileId)
        return join(root, 'profiles', profileId)
      },
      reload: (profileId, signal, entryIds, guard, removedIds) => reloadProfileMcpRuntime({
        workers,
        resolveProfile: id => requiredProfile(registry, id),
        ensureWorker,
      }, profileId, signal, entryIds, guard, removedIds),
    })
    const skillExecutor = new ProfileSkillExecutor({
      uid,
      catalog: async (profileId, signal) => {
        requiredProfile(registry, profileId)
        return readProfileSkillCatalog(await workers.activate(profileId), signal)
      },
      profileRoot: (profileId) => {
        requiredProfile(registry, profileId)
        return join(root, 'profiles', profileId)
      },
      acknowledge: async (profileId, name, _content, signal, guard) => {
        guard()
        const profile = requiredProfile(registry, profileId)
        await workers.dispose(profileId)
        guard()
        await ensureWorker(profile)
        guard()
        return readProfileSkillRuntime(await workers.activate(profileId), name, signal)
      },
    })
    const pnpmEntrypointPath = config.pnpmEntrypointPath
    const pluginExecutor = pnpmEntrypointPath === undefined ? undefined : new ProfilePluginExecutor({
      uid,
      inspectScripts: (packageName, spec, signal) => inspectPluginScripts({ packageName, spec, ...(signal ? { signal } : {}) }),
      togglePlan: (profileId, packageName, enabled, patch) => {
        requiredProfile(registry, profileId)
        const profileRoot = join(root, 'profiles', profileId)
        const loaded = loadProfileDirectory('dsh', join(profileRoot, 'profiles/web'), config.dshEntrypointPath)
        const homePatch = join(profileRoot, 'cordis.patch.yml')
        /* v8 ignore next -- ensureWorker materializes homePatch before any authorized extension operation. */
        return planPluginToggle(loaded.layers, patch, existsSync(homePatch) ? loadOverlayPatches('dsh', homePatch) : [], packageName, enabled)
      },
      repair: (profileRoot, packageName, context) => runProfilePluginCommand({
        nodeExecutablePath: config.nodeExecutablePath, dshEntrypointPath: config.dshEntrypointPath,
        pnpmEntrypointPath, profileRoot, controlRoot: join(root, 'control'), uid, spec: packageName, action: 'repair',
        signal: context.signal, guard: context.guard,
      }),
      remove: (profileRoot, packageName, context) => runProfilePluginCommand({
        nodeExecutablePath: config.nodeExecutablePath, dshEntrypointPath: config.dshEntrypointPath,
        pnpmEntrypointPath, profileRoot, controlRoot: join(root, 'control'), uid, spec: packageName, action: 'remove',
        signal: context.signal, guard: context.guard,
      }),
      acknowledgeRemoval: async (profileId, ids, context) => {
        context.guard(); context.signal.throwIfAborted()
        const profile = requiredProfile(registry, profileId)
        await workers.dispose(profileId)
        context.guard(); await ensureWorker(profile); context.guard()
        await waitForPluginRuntime(await workers.activate(profileId), [], context.signal, ids)
      },
      acknowledgeToggle: async (profileId, plan, context) => {
        context.guard(); context.signal.throwIfAborted()
        const profile = requiredProfile(registry, profileId)
        await workers.dispose(profileId)
        context.guard(); context.signal.throwIfAborted()
        await ensureWorker(profile)
        context.guard(); context.signal.throwIfAborted()
        await waitForPluginRuntime(await workers.activate(profileId), plan.expected, context.signal, [], plan.disabled)
      },
      resolve: (profileId) => {
        requiredProfile(registry, profileId)
        return join(root, 'profiles', profileId)
      },
      install: (profileRoot, spec, context) => runProfilePluginCommand({
        nodeExecutablePath: config.nodeExecutablePath, dshEntrypointPath: config.dshEntrypointPath,
        pnpmEntrypointPath, profileRoot, controlRoot: join(root, 'control'), uid, spec,
        signal: context.signal, guard: context.guard,
        ...(context.buildApproval ? { allowBuild: context.buildApproval.buildKey } : {}),
      }),
      acknowledge: async (profileId, packageName, context) => {
        context.guard(); context.signal.throwIfAborted()
        const profile = requiredProfile(registry, profileId)
        const profileRoot = join(root, 'profiles', profileId)
        const loaded = loadProfileDirectory('dsh', join(profileRoot, 'profiles/web'), config.dshEntrypointPath)
        const homePatch = join(profileRoot, 'cordis.patch.yml')
        /* v8 ignore next -- ensureWorker materializes homePatch before plugin acknowledgement. */
        const overrides = [...loaded.patches, ...(existsSync(homePatch) ? loadOverlayPatches('dsh', homePatch) : [])]
        const expected = pluginBundleEntries(loaded.layers, overrides, packageName)
        await workers.dispose(profileId)
        context.guard(); context.signal.throwIfAborted()
        await ensureWorker(profile)
        context.guard(); context.signal.throwIfAborted()
        await waitForPluginRuntime(await workers.activate(profileId), expected, context.signal)
      },
    })
    const executor = new ProfileExtensionExecutor(mcpExecutor, skillExecutor, pluginExecutor)
    const extensionOperations = new ProfileExtensionOperations(
      new FileExtensionReceipts(join(root, 'control', 'extension-receipts'), uid), executor, clock,
    )
    const socketPath = join(root, 'host.sock')
    let modelClaimCoordinator: LegacyClaimCoordinator | undefined
    const claims = (): LegacyClaimCoordinator => {
      if (modelClaimCoordinator) return modelClaimCoordinator
      // Load the global ledger only for a claim request. Corruption cannot prevent unrelated DSH Profiles from booting.
      const ledger = new LegacyClaimLedger(new FileLegacyClaimEventStore({
        root: join(root, 'control', 'legacy-model-claims'), uid, maximumBytes: 4 * 1024 * 1024,
      }), () => clock.now())
      const recovery = new LegacyClaimRecoveryStore(new FileLegacyClaimRecoveryFiles(join(root, 'profiles'), uid))
      modelClaimCoordinator = new LegacyClaimCoordinator({
        ledger, marker: claimMarker, recovery,
        /* v8 ignore start -- initial claims are not exposed by this recovery-only control capability. */
        readSource: (signal?: AbortSignal) => readLegacyModelClaimDocuments({
          expectedUid: uid, assertSourceQuiescent: () => Promise.resolve(),
          ...(signal === undefined ? {} : { signal }),
        }),
        /* v8 ignore stop */
        targetGeneration: async profileId => (await targetFor(profileId).activePersistenceConfig()).generation,
        target: (profileId, generation) => {
          const ownerRoot = join(root, 'profiles', profileId, 'migration-owner-state', String(generation))
          return new LegacyClaimTarget(new FileLegacyClaimTargetFiles({
            generation, settingsPath: join(ownerRoot, 'settings.yaml'),
            credentialsPath: join(ownerRoot, '.credentials.yaml'), storageRoot: join(ownerRoot, 'storages'),
          }, uid), recovery)
        },
        stopWorker: profileId => claimWorkerGate.stop(profileId, () => workers.dispose(profileId)),
        startWorker: profileId => ensureWorker(requiredProfile(registry, profileId), true),
      })
      return modelClaimCoordinator
    }
    const serverOptions: UnixHostServerOptions = {
      socketPath, ownership, expectedUid: uid,
      allowedDesktopExecutableDigests: new Set(config.desktopExecutableDigests),
      attestPeer: dependencies.attestPeer
        ?? createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(config.desktopTeamIdentifiers) }),
      identity: {
        hostInstanceId: config.hostInstanceId, installationId: config.installationId,
        installationPublicKey: config.installationPublicKey,
        installationPrivateKey: ownerFile(config.installationPrivateKeyPath, uid),
        processNonce: config.processNonce, executableSignatureDigest: config.executableSignatureDigest,
        runtimeGeneration: config.runtimeGeneration, schemaGeneration: config.schemaGeneration,
      },
      host,
      generateModelText: (profileId, text, signal) => workers.generateText(profileId, text, signal),
      extensions: { operations: extensionOperations, kinds: pluginExecutor ? ['plugin', 'mcp', 'skill'] : ['mcp', 'skill'],
        pluginRemove: pluginExecutor !== undefined, pluginUpdate: pluginExecutor !== undefined, pluginToggle: pluginExecutor !== undefined,
        skillArchives: true, skillRemove: true, skillReplace: true, skillFiles: true, skillInvocation: true,
        mcpRemove: true, mcpUpdate: true,
        inventory: (profileId, kind, signal) => executor.inventory(profileId, kind, signal) },
      profilePersistenceGeneration: async profileId => (await targetFor(profileId).activePersistenceConfig()).generation,
      modelClaimRecovery: {
        pendingReceipts: (input: Parameters<LegacyClaimCoordinator['pendingReceipts']>[0]) =>
          claims().pendingReceipts(input),
        status: (input: Parameters<LegacyClaimCoordinator['status']>[0]) => claims().status(input),
        restore: (input: Parameters<LegacyClaimCoordinator['restore']>[0]) => claims().restore(input),
      },
      ...(config.legacySourceQuiescent === true ? {
        modelClaimTransaction: {
          /* v8 ignore next -- production source home is fixed; coordinator and control authority are tested separately. */
          claim: (input: Parameters<LegacyClaimCoordinator['claim']>[0]) => claims().claim(input),
          /* v8 ignore next -- retry reads the fixed production source; coordinator and authority tests cover it. */
          retry: (input: Parameters<LegacyClaimCoordinator['retry']>[0]) => claims().retry(input),
        },
        inspectModelClaimSource: (signal?: AbortSignal) => inspectLegacyModelClaimSource({
          expectedUid: uid, assertSourceQuiescent: () => Promise.resolve(),
          ...(signal === undefined ? {} : { signal }),
        }),
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
        const profile = requiredProfile(registry, profileId)
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
            const profile = requiredProfile(registry, profileId)
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
    }
    server = dependencies.createServer?.(serverOptions) ?? new UnixHostServer(serverOptions)
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
    /* v8 ignore next -- no worker can exist before server.start succeeds; worker failures are owned by supervisor tests. */
    await workers.disposeAll().catch(() => undefined)
    await ownership?.release().catch(() => undefined)
    throw error
  }
}

/** Platform selection and application factories; omitted factories use the native adapters. */
export interface StartConfiguredDesktopHostDependencies {
  readonly platform?: NodeJS.Platform
  readonly startMacOS?: (config: Config) => Promise<DesktopHostApplication>
  readonly startWindows?: (
    config: WindowsDesktopHostPrivateFileConfig,
  ) => Promise<WindowsDesktopHostApplication>
}

/**
 * Select exactly one platform adapter; unsupported packages fail closed.
 * @param config - Host settings passed to the selected adapter.
 * @param dependencies - Optional platform and startup factories for embedding or tests.
 * @returns Started application whose close operation belongs to the caller; rejects startup failures.
 */
export async function startConfiguredDesktopHostApplication(
  config: Config,
  dependencies: StartConfiguredDesktopHostDependencies = {},
): Promise<ClosableDesktopHostApplication> {
  const platform = dependencies.platform ?? process.platform
  if (platform === 'darwin') return (dependencies.startMacOS ?? startDesktopHostApplication)(config)
  if (platform === 'win32') {
    /* v8 ignore next -- the default native adapter is exercised by the dedicated Windows Host jobs. */
    return (dependencies.startWindows ?? startWindowsDesktopHostApplicationFromPrivateFiles)(
      windowsDesktopHostConfig(config),
    )
  }
  throw new HostAuthorityError('unavailable')
}

/** Start and dispose the platform application with its Cordis profile lifecycle. */
export async function apply(
  ctx: Context,
  config: Config,
  dependencies: StartConfiguredDesktopHostDependencies = {},
): Promise<void> {
  await ctx.effect(async () => {
    const application = await startConfiguredDesktopHostApplication(config, dependencies)
    return () => application.close()
  })
}

export {
  prepareWindowsDesktopHostEmbeddingIdentity,
  type PrepareWindowsDesktopHostEmbeddingIdentityDependencies,
  type WindowsDesktopHostEmbeddingIdentity,
} from './windows-embedding-identity.ts'

export {
  startWindowsDesktopHostApplication,
  startWindowsDesktopHostApplicationFromPrivateFiles,
  type StartWindowsDesktopHostApplicationDependencies,
  type WindowsDesktopHostApplication,
  type WindowsDesktopHostBaseConfig,
  type WindowsDesktopHostConfig,
  type WindowsDesktopHostPrivateFileConfig,
} from './windows-startup.ts'
