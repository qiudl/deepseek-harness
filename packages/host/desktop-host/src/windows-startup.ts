import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { win32 } from 'node:path'
import { DshAccountAccessTokenVerifier } from './account-access-token.ts'
import { DesktopHost } from './desktop-host.ts'
import { ProfileExtensionOperations } from './extension-operations.ts'
import { ProfileMcpExecutor } from './profile-mcp-executor.ts'
import { reloadProfileMcpRuntime } from './mcp-runtime-ack.ts'
import { WindowsMcpStorage } from './windows-mcp-storage.ts'
import { WindowsExtensionReceipts } from './windows-extension-receipts.ts'
import {
  DshWebProfileWorkerFactory,
  type DshWebProfileWorkerFactoryOptions,
  type ProfileListenerAttestor,
} from './dsh-web-profile-worker.ts'
import { ProfileRegistry } from './profile-registry.ts'
import { ProfileClaimMarker, WindowsProfileClaimMarkerFiles } from './legacy-claim-marker.ts'
import { SessionCommandAuthority } from './session-command.ts'
import type { HostClock, PersonProfileRecord, ProfileWorkerFactory } from './types.ts'
import { HostAuthorityError } from './types.ts'
import { HostControlAuthority } from './unix-transport.ts'
import { loadWindowsCurrentUserSid } from './windows-current-user-native.ts'
import { WindowsHostJournal } from './windows-host-journal.ts'
import { loadWindowsHostRegistrationFileBindings } from './windows-host-registration-native.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import {
  startWindowsHostTransport,
  type StartWindowsHostTransportDependencies,
  type StartWindowsHostTransportOptions,
  type WindowsHostTransport,
} from './windows-host-transport.ts'
import { prepareWindowsIsolatedProfile } from './windows-isolated-profile.ts'
import { loadWindowsProfileListenerAttestor } from './windows-profile-listener-attestor.ts'
import { createWindowsProfileRegistryFileAuthority } from './windows-profile-registry-files.ts'
import {
  loadPinnedWindowsVaultNativeModule,
  type WindowsVaultNativeModulePin,
} from './windows-pinned-vault-native.ts'
import { loadWindowsWorkerIoCancellation } from './windows-worker-io-cancellation.ts'
import { ProfileWorkerSupervisor } from './worker-supervisor.ts'

const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u

/** Non-secret, embedding-pinned inputs for the private Windows Host composition. */
export interface WindowsDesktopHostBaseConfig extends Omit<
  StartWindowsHostTransportOptions,
  'allowedExecutableDigests' | 'initializeOwnedResources' | 'openSession' | 'quiesceOwnedResources'
> {
  readonly root: string
  readonly nodeExecutablePath: string
  readonly dshEntrypointPath: string
  readonly accountKeyringSha256: string
  readonly hostInstanceId: string
  readonly runtimeGeneration: number
  readonly schemaGeneration: number
  readonly allowedDesktopExecutableDigests: ReadonlySet<string>
  readonly nativeModule: WindowsVaultNativeModulePin
  readonly maximumRegistryBytes: number
  readonly maximumManagedFileBytes: number
  readonly maximumJournalBytes: number
  /** Explicit receipt capacity enables MCP extensions; omission retains the existing local-only composition. */
  readonly maximumExtensionReceiptBytes?: number
  readonly profileReadyTimeoutMs: number
  readonly profileAbortTimeoutMs: number
}

/** Trusted in-memory inputs used by embedders and deterministic tests. */
export interface WindowsDesktopHostConfig extends WindowsDesktopHostBaseConfig {
  readonly deviceIndexKey: Uint8Array
  readonly accountAccessKeyring: string
  readonly installationPrivateKey: KeyObject | string | Buffer
}

/** Private files read through stable Windows handles only after the Host lock is held. */
export interface WindowsDesktopHostPrivateFileConfig extends WindowsDesktopHostBaseConfig {
  readonly deviceIndexKeyPath: string
  readonly accountKeyringPath: string
  readonly installationPrivateKeyPath: string
}

/** Running Windows Host; transport shutdown also quiesces every Profile child before lock release. */
export interface WindowsDesktopHostApplication {
  readonly host: DesktopHost
  readonly workers: ProfileWorkerSupervisor
  readonly commandAuthority: SessionCommandAuthority
  readonly transport: WindowsHostTransport
  close(): Promise<void>
}

type StartTransport = (
  options: StartWindowsHostTransportOptions,
  dependencies?: StartWindowsHostTransportDependencies,
) => Promise<WindowsHostTransport>

/** Native and process seams used only by deterministic composition tests. */
export interface StartWindowsDesktopHostApplicationDependencies {
  readonly loadCurrentUserSid?: typeof loadWindowsCurrentUserSid
  readonly loadRegistrationFileBindings?: typeof loadWindowsHostRegistrationFileBindings
  readonly loadProfileListenerAttestor?: typeof loadWindowsProfileListenerAttestor
  readonly loadWorkerIoCancellation?: typeof loadWindowsWorkerIoCancellation
  readonly createProfileWorkerFactory?: (options: DshWebProfileWorkerFactoryOptions) => ProfileWorkerFactory
  readonly startTransport?: StartTransport
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function windowsRoot(value: string): boolean {
  return DRIVE_ROOTED_PATH.test(value) && !CONTROL_CHARACTER.test(value)
    && !value.slice(2).includes(':') && win32.normalize(value) === value
}

interface WindowsOwnedTrust {
  readonly deviceIndexKey: Buffer
  readonly accountAccessKeyring: string
  readonly installationPrivateKey: KeyObject
}

function validatePublicConfig(config: WindowsDesktopHostBaseConfig): void {
  if ((config.platform ?? process.platform) !== 'win32' || (config.arch ?? process.arch) !== 'x64'
    || !windowsRoot(config.root) || !windowsRoot(config.registrationRoot)
    || win32.dirname(config.root) === config.root
    || config.registrationRoot !== win32.join(config.root, 'host')
    || !win32.isAbsolute(config.nodeExecutablePath) || !win32.isAbsolute(config.dshEntrypointPath)
    || config.workerEntry.protocol !== 'file:'
    || !win32.isAbsolute(config.nativeModule.path)
    || win32.normalize(config.nativeModule.path) !== config.nativeModule.path
    || win32.basename(config.nativeModule.path) !== 'koffi.node'
    || !SHA256.test(config.nativeModule.sha256)
    || !SHA256.test(config.accountKeyringSha256)
    || !PUBLIC_KEY.test(config.installationPublicKey)
    || !positive(config.runtimeGeneration) || !positive(config.schemaGeneration)
    || !positive(config.maximumRegistryBytes) || !positive(config.maximumManagedFileBytes)
    || !positive(config.maximumJournalBytes) || !positive(config.profileReadyTimeoutMs)
    || (config.maximumExtensionReceiptBytes !== undefined && !positive(config.maximumExtensionReceiptBytes))
    || !positive(config.profileAbortTimeoutMs)) throw new HostAuthorityError('invalid_input')
}

function validateOwnedTrust(
  config: WindowsDesktopHostBaseConfig,
  trust: {
    readonly deviceIndexKey: Uint8Array
    readonly accountAccessKeyring: string
    readonly installationPrivateKey: KeyObject | string | Buffer
  },
): WindowsOwnedTrust {
  if (trust.deviceIndexKey.byteLength !== 32
    || createHash('sha256').update(trust.accountAccessKeyring).digest('hex') !== config.accountKeyringSha256) {
    throw new HostAuthorityError('invalid_input')
  }
  let privateKey: KeyObject
  try {
    privateKey = trust.installationPrivateKey instanceof Object && 'type' in trust.installationPrivateKey
      ? trust.installationPrivateKey
      : createPrivateKey(trust.installationPrivateKey)
    const derived = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')
    if (privateKey.asymmetricKeyType !== 'ed25519' || derived !== config.installationPublicKey) {
      throw new HostAuthorityError('invalid_input')
    }
  } catch (error) {
    if (error instanceof HostAuthorityError) throw error
    throw new HostAuthorityError('invalid_input')
  }
  return {
    deviceIndexKey: Buffer.from(trust.deviceIndexKey),
    accountAccessKeyring: trust.accountAccessKeyring,
    installationPrivateKey: privateKey,
  }
}

function ownedPrivateFile(
  bindings: WindowsHostRegistrationFileBindings,
  path: string,
  maximumBytes: number,
  userSid: string,
): Buffer {
  const file = bindings.readPrivateFile(path, maximumBytes)
  if (file === undefined || file.contents.length < 1 || file.contents.length > maximumBytes) {
    throw new HostAuthorityError('unavailable')
  }
  assertWindowsHostPrivatePathEvidence(file.evidence, 'file', userSid)
  return Buffer.from(file.contents)
}

function privateFilePath(root: string, path: string, filename: string): boolean {
  return windowsRoot(path) && path === win32.join(root, 'identity', filename)
}

function loadOwnedTrustFromPrivateFiles(
  config: WindowsDesktopHostPrivateFileConfig,
  userSid: string,
  bindings: WindowsHostRegistrationFileBindings,
): WindowsOwnedTrust {
  const deviceIndexKey = ownedPrivateFile(bindings, config.deviceIndexKeyPath, 32, userSid)
  if (deviceIndexKey.length !== 32) throw new HostAuthorityError('unavailable')
  const keyring = ownedPrivateFile(bindings, config.accountKeyringPath, 16 * 1024, userSid)
  const privateKey = ownedPrivateFile(bindings, config.installationPrivateKeyPath, 16 * 1024, userSid)
  let accountAccessKeyring: string
  try {
    accountAccessKeyring = new TextDecoder('utf-8', { fatal: true }).decode(keyring)
  } catch {
    throw new HostAuthorityError('unavailable')
  }
  return validateOwnedTrust(config, {
    deviceIndexKey,
    accountAccessKeyring,
    installationPrivateKey: privateKey,
  })
}

/**
 * Assemble the Windows Host with local Profile availability independent of migration support.
 * Migration capabilities remain absent until a Windows-native journal and import target are wired.
 * @param config - Explicit Windows paths, release trust anchors, and in-memory private identity.
 * @param clock - Clock used for authorization and Profile registry timestamps.
 * @param dependencies - Optional native loaders, transport, and Profile worker factory.
 * @returns Started Host owned by the caller; rejects invalid trust or failed startup.
 */
export async function startWindowsDesktopHostApplication(
  config: WindowsDesktopHostConfig,
  clock: HostClock = { now: Date.now },
  dependencies: StartWindowsDesktopHostApplicationDependencies = {},
): Promise<WindowsDesktopHostApplication> {
  validatePublicConfig(config)
  const trust = validateOwnedTrust(config, config)
  return startWindowsDesktopHostApplicationWithTrust(config, () => trust, clock, dependencies)
}

/**
 * Start from ACL-pinned files without ever placing private material in environment variables.
 * Private identity reads occur only after exclusive Host ownership has been acquired.
 * @param config - Explicit Windows configuration naming the exact private identity files.
 * @param clock - Clock used for authorization and Profile registry timestamps.
 * @param dependencies - Optional native loaders, transport, and Profile worker factory.
 * @returns Started Host owned by the caller; rejects invalid files, trust, or startup failures.
 */
export async function startWindowsDesktopHostApplicationFromPrivateFiles(
  config: WindowsDesktopHostPrivateFileConfig,
  clock: HostClock = { now: Date.now },
  dependencies: StartWindowsDesktopHostApplicationDependencies = {},
): Promise<WindowsDesktopHostApplication> {
  validatePublicConfig(config)
  if (!privateFilePath(config.root, config.deviceIndexKeyPath, 'device-index-key.v1')
    || !privateFilePath(config.root, config.accountKeyringPath, 'account-access-keyring.v2.json')
    || !privateFilePath(config.root, config.installationPrivateKeyPath, 'installation-private-key.pem')) {
    throw new HostAuthorityError('invalid_input')
  }
  return startWindowsDesktopHostApplicationWithTrust(
    config,
    (userSid, bindings) => loadOwnedTrustFromPrivateFiles(config, userSid, bindings),
    clock,
    dependencies,
  )
}

async function startWindowsDesktopHostApplicationWithTrust(
  config: WindowsDesktopHostBaseConfig,
  loadTrust: (userSid: string, bindings: WindowsHostRegistrationFileBindings) => WindowsOwnedTrust,
  clock: HostClock,
  dependencies: StartWindowsDesktopHostApplicationDependencies,
): Promise<WindowsDesktopHostApplication> {
  let pinnedNative: ReturnType<typeof loadPinnedWindowsVaultNativeModule> | undefined
  /* v8 ignore next 3 -- the signed native addon loader is exercised by the Windows platform lane. */
  const loadKoffi = () => Promise.resolve(
    pinnedNative ??= loadPinnedWindowsVaultNativeModule(config.nativeModule),
  )
  const nativeOptions = {
    platform: config.platform ?? process.platform,
    arch: config.arch ?? process.arch,
    loadKoffi,
  }
  /* v8 ignore next 5 -- the signed native adapter is exercised by the Windows platform lane. */
  const attestListener: ProfileListenerAttestor = await (
    dependencies.loadProfileListenerAttestor
      ?? (() => loadWindowsProfileListenerAttestor({ ...nativeOptions, loadKoffi }))
  )()
  const profileWorkerOptions = {
    nodeExecutablePath: config.nodeExecutablePath,
    dshEntrypointPath: config.dshEntrypointPath,
    attestListener,
    readyTimeoutMs: config.profileReadyTimeoutMs,
    abortTimeoutMs: config.profileAbortTimeoutMs,
  }
  /* v8 ignore next 7 -- Windows path admission and the packaged child process run in the Windows platform lane. */
  const defaultProfileWorkerFactory = dependencies.createProfileWorkerFactory === undefined
    ? new DshWebProfileWorkerFactory(profileWorkerOptions)
    : undefined
  /* v8 ignore next 2 -- the production factory callback is exercised with Windows paths in the Windows platform lane. */
  const createProfileWorker = dependencies.createProfileWorkerFactory?.(profileWorkerOptions)
    ?? (spec => (defaultProfileWorkerFactory as DshWebProfileWorkerFactory).create(spec))
  const workers = new ProfileWorkerSupervisor(createProfileWorker)
  let state: {
    readonly host: DesktopHost
    readonly commandAuthority: SessionCommandAuthority
    readonly authority: HostControlAuthority
    readonly extensionOperations?: ProfileExtensionOperations
  } | undefined
  /* v8 ignore next -- the signed native adapter is exercised by the Windows platform lane. */
  const loadCancellation = dependencies.loadWorkerIoCancellation
    ?? (() => loadWindowsWorkerIoCancellation({ ...nativeOptions, loadKoffi }))
  /* v8 ignore next -- the signed native adapter is exercised by the Windows platform lane. */
  const loadCurrentUserSid = dependencies.loadCurrentUserSid
    ?? (() => loadWindowsCurrentUserSid({ ...nativeOptions, loadKoffi }))
  /* v8 ignore next 5 -- the signed native adapter is exercised by the Windows platform lane. */
  const loadRegistrationFileBindings = dependencies.loadRegistrationFileBindings
    ?? (() => loadWindowsHostRegistrationFileBindings({
      ...nativeOptions,
      loadKoffi,
    }))
  /* v8 ignore next -- the production transport default is exercised by the Windows platform lane. */
  const startTransport = dependencies.startTransport ?? startWindowsHostTransport
  const transport = await startTransport({
    ...(config.platform === undefined ? {} : { platform: config.platform }),
    ...(config.arch === undefined ? {} : { arch: config.arch }),
    installationId: config.installationId,
    endpointRegistrationId: config.endpointRegistrationId,
    installationPublicKey: config.installationPublicKey,
    executableSignatureDigest: config.executableSignatureDigest,
    registrationRoot: config.registrationRoot,
    processNonce: config.processNonce,
    workerEntry: config.workerEntry,
    workerGeneration: config.workerGeneration,
    allowedPublisherThumbprints: config.allowedPublisherThumbprints,
    allowedExecutableDigests: config.allowedDesktopExecutableDigests,
    nativeModule: config.nativeModule,
    maxCancelAttempts: config.maxCancelAttempts,
    waitForCancelRetry: config.waitForCancelRetry,
    startupDeadline: config.startupDeadline,
    exitWithoutHandleDeadline: config.exitWithoutHandleDeadline,
    sessionCleanupDeadline: config.sessionCleanupDeadline,
    processFallback: config.processFallback,
    ...(config.onFailure === undefined ? {} : { onFailure: config.onFailure }),
    initializeOwnedResources: ({ userSid, bindings }) => {
      const trust = loadTrust(userSid, bindings)
      const accountAccessVerifier = new DshAccountAccessTokenVerifier(trust.accountAccessKeyring, {
        now: () => clock.now(),
      })
      const registryRoot = win32.join(config.root, 'registry')
      const registryFiles = createWindowsProfileRegistryFileAuthority({
        root: registryRoot,
        userSid,
        maximumSnapshotBytes: config.maximumRegistryBytes,
        bindings,
      })
      const registry = new ProfileRegistry({
        root: registryRoot,
        snapshotPath: win32.join(registryRoot, 'profiles.json'),
        deviceIndexKey: trust.deviceIndexKey,
        clock,
        prepareRoot: (root) => { registryFiles.prepareRoot(root) },
        loadSnapshot: path => registryFiles.loadSnapshot(path),
        persistSnapshot: (path, root, snapshot) => { registryFiles.persistSnapshot(path, root, snapshot) },
      })
      const claimMarker = new ProfileClaimMarker(new WindowsProfileClaimMarkerFiles({
        profilesRoot: win32.join(config.root, 'profiles'), userSid, bindings,
      }))
      const ensureWorker = async (profile: PersonProfileRecord): Promise<void> => {
        const prepared = prepareWindowsIsolatedProfile({
          root: config.root,
          profileId: profile.profileId,
          userSid,
          maximumManagedFileBytes: config.maximumManagedFileBytes,
          prepareMcpStorage: config.maximumExtensionReceiptBytes !== undefined,
          bindings,
        })
        if (claimMarker.pending(profile.profileId)) throw new HostAuthorityError('unavailable')
        await workers.ensure({
          profileId: profile.profileId,
          profileRoot: prepared.profileRoot,
          credentialHandle: profile.keyHandle,
          pluginRoots: prepared.pluginRoots,
        })
      }
      const host = new DesktopHost({
        registry,
        clock,
        runtimeGeneration: config.runtimeGeneration,
        verifyAccountAccessToken: token => accountAccessVerifier.verify(token),
        activateProfileView: profileId => workers.activate(profileId),
        ensureProfileWorker: ensureWorker,
      })
      const commandAuthority = new SessionCommandAuthority(new WindowsHostJournal({
        root: win32.join(config.root, 'control'),
        userSid,
        maximumJournalBytes: config.maximumJournalBytes,
        bindings,
      }), clock)
      const mcp = config.maximumExtensionReceiptBytes === undefined ? undefined : new ProfileMcpExecutor({
        storage: new WindowsMcpStorage({
          userSid, bindings, profileRoot: profileId => win32.join(config.root, 'profiles', profileId),
        }),
        reload: (profileId, signal, entryIds, guard, removedIds) => reloadProfileMcpRuntime({
          workers,
          resolveProfile: id => registry.resolveProfile(id as never),
          ensureWorker,
        }, profileId, signal, entryIds, guard, removedIds),
      })
      const extensionOperations = mcp && config.maximumExtensionReceiptBytes !== undefined
        ? new ProfileExtensionOperations(new WindowsExtensionReceipts({
          root: win32.join(config.root, 'control'), userSid, bindings, maximumBytes: config.maximumExtensionReceiptBytes,
        }), mcp, clock) : undefined
      const authority = new HostControlAuthority({
        identity: {
          hostInstanceId: config.hostInstanceId,
          installationId: config.installationId,
          installationPublicKey: config.installationPublicKey,
          installationPrivateKey: trust.installationPrivateKey,
          processNonce: config.processNonce,
          executableSignatureDigest: config.executableSignatureDigest,
          runtimeGeneration: config.runtimeGeneration,
          schemaGeneration: config.schemaGeneration,
        },
        host,
        ...(mcp && extensionOperations ? { extensions: { operations: extensionOperations, kinds: ['mcp'] as const,
          mcpRemove: true, mcpUpdate: true, inventory: (profileId: string) => mcp.inventory(profileId) } } : {}),
        profilePersistenceGeneration: () => 1,
        now: () => clock.now(),
      })
      state = { host, commandAuthority, authority, ...(extensionOperations ? { extensionOperations } : {}) }
    },
    openSession: (ownerId, signal) => {
      if (state === undefined) throw new HostAuthorityError('unavailable')
      return state.authority.openSession(ownerId, signal)
    },
    quiesceOwnedResources: async () => {
      try { await state?.extensionOperations?.dispose() } finally { await workers.disposeAll() }
    },
  }, { loadCancellation, loadCurrentUserSid, loadRegistrationFileBindings })
  if (state === undefined) {
    await transport.close().catch(() => undefined)
    throw new HostAuthorityError('unavailable')
  }
  return {
    host: state.host,
    workers,
    commandAuthority: state.commandAuthority,
    transport,
    close: () => transport.close(),
  }
}
