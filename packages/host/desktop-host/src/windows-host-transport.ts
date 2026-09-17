import {
  assertWindowsHostCarrierInputs,
  startWindowsHostCarrier,
  WindowsHostProcessFallbackRequiredError,
  type StartWindowsHostCarrierOptions,
  type WindowsHostCarrier,
} from './windows-host-carrier.ts'
import {
  startWindowsHostWorkerThread,
  type StartWindowsHostWorkerThreadOptions,
} from './windows-host-worker-thread.ts'
import type { WindowsHostWorkerSession } from './windows-host-worker-bridge.ts'
import type { WindowsVaultNativeModulePin } from './windows-pinned-vault-native.ts'
import { loadWindowsCurrentUserSid } from './windows-current-user-native.ts'
import { WindowsHostRegistrationPublisher } from './windows-host-registration.ts'
import type { WindowsHostRegistrationFileBindings } from './windows-host-registration.ts'
import { loadWindowsHostRegistrationFileBindings } from './windows-host-registration-native.ts'
import { acquireWindowsSingleHostLock, type WindowsSingleHostLock } from './windows-single-instance.ts'
import {
  loadWindowsWorkerIoCancellation,
  type WindowsWorkerIoCancellation,
} from './windows-worker-io-cancellation.ts'

/** Complete parent-thread inputs for the private Windows transport composition. */
export interface StartWindowsHostTransportOptions extends Omit<
  StartWindowsHostCarrierOptions,
  'startWorker' | 'resolveCurrentUserSid' | 'publishRegistration'
> {
  readonly registrationRoot: string
  readonly processNonce: string
  readonly workerEntry: URL
  readonly workerGeneration: number
  readonly allowedPublisherThumbprints: ReadonlySet<string>
  readonly allowedPackageFamilyNames?: ReadonlySet<string>
  readonly allowedExecutableDigests: ReadonlySet<string>
  readonly nativeModule: WindowsVaultNativeModulePin
  readonly maxCancelAttempts: number
  readonly waitForCancelRetry: () => Promise<void>
  readonly startupDeadline: (signal: AbortSignal) => Promise<void>
  readonly exitWithoutHandleDeadline: (signal: AbortSignal) => Promise<void>
  readonly sessionCleanupDeadline: (signal: AbortSignal) => Promise<void>
  readonly initializeOwnedResources: (context: {
    readonly userSid: string
    readonly bindings: WindowsHostRegistrationFileBindings
  }) => void | Promise<void>
  readonly quiesceOwnedResources: () => Promise<void>
  readonly openSession: (connectionId: string, signal: AbortSignal) => WindowsHostWorkerSession
}

/** Parent composition that releases single-Host ownership only after Worker quiescence. */
export class WindowsHostTransport {
  private closing: Promise<void> | undefined

  constructor(
    private readonly carrier: WindowsHostCarrier,
    private readonly ownership: WindowsSingleHostLock,
    private readonly quiesceOwnedResources: StartWindowsHostTransportOptions['quiesceOwnedResources'],
    private readonly processFallback: StartWindowsHostCarrierOptions['processFallback'],
  ) {}

  assertHealthy(): void {
    this.carrier.assertHealthy()
    this.ownership.assertOwner()
  }

  close(): Promise<void> {
    this.closing ??= this.closeOwned()
    return this.closing
  }

  private async closeOwned(): Promise<void> {
    await this.carrier.close()
    try { await this.quiesceOwnedResources() } catch (error) {
      const cause = error instanceof Error ? error : new Error('Unknown Windows Host owned-resource shutdown failure')
      const request = { reason: 'owned_resources_stop_failed' as const, cause }
      try { await this.processFallback(request) } catch (fallbackError) {
        throw new WindowsHostProcessFallbackRequiredError(request, fallbackError)
      }
      throw new WindowsHostProcessFallbackRequiredError(request, cause)
    }
    try { this.ownership.release() } catch (error) {
      const cause = error instanceof Error ? error : new Error('Unknown Windows Host ownership release failure')
      const request = { reason: 'ownership_release_failed' as const, cause }
      try { await this.processFallback(request) } catch (fallbackError) {
        throw new WindowsHostProcessFallbackRequiredError(request, fallbackError)
      }
      throw new WindowsHostProcessFallbackRequiredError(request, cause)
    }
  }
}

/** Native and Worker seams used only by deterministic composition tests. */
export interface StartWindowsHostTransportDependencies {
  readonly loadCancellation?: () => Promise<WindowsWorkerIoCancellation>
  readonly loadCurrentUserSid?: () => Promise<() => string>
  readonly loadRegistrationFileBindings?: () => Promise<WindowsHostRegistrationFileBindings>
  readonly startWorkerThread?: (
    options: StartWindowsHostWorkerThreadOptions,
  ) => ReturnType<typeof startWindowsHostWorkerThread>
}

/**
 * Start the production Windows pipe carrier with its file Worker and bounded parent cancellation.
 * The returned carrier still owns process-fallback escalation for every unconfirmed shutdown.
 */
export async function startWindowsHostTransport(
  options: StartWindowsHostTransportOptions,
  dependencies: StartWindowsHostTransportDependencies = {},
): Promise<WindowsHostTransport> {
  assertWindowsHostCarrierInputs(options)
  if (options.workerEntry.protocol !== 'file:') throw new Error('Windows Host Worker entry must be a file URL')
  /* v8 ignore next -- the production native default is exercised only by signed Windows lanes. */
  const cancellation = await (dependencies.loadCancellation ?? loadWindowsWorkerIoCancellation)()
  /* v8 ignore next -- the production identity default is exercised only by signed Windows lanes. */
  const resolveCurrentUserSid = await (dependencies.loadCurrentUserSid ?? loadWindowsCurrentUserSid)()
  const userSid = resolveCurrentUserSid()
  /* v8 ignore next -- the production filesystem default is exercised only by signed Windows lanes. */
  const registrationBindings = await (
    dependencies.loadRegistrationFileBindings ?? loadWindowsHostRegistrationFileBindings
  )()
  const registrationPublisher = new WindowsHostRegistrationPublisher({
    root: options.registrationRoot,
    userSid,
    bindings: registrationBindings,
  })
  const ownership = acquireWindowsSingleHostLock({
    root: options.registrationRoot,
    userSid,
    pid: process.pid,
    processNonce: options.processNonce,
    bindings: registrationBindings,
  })
  /* v8 ignore next -- the production Worker default is exercised only by signed Windows lanes. */
  const startWorkerThread = dependencies.startWorkerThread ?? startWindowsHostWorkerThread
  try {
    await options.initializeOwnedResources({ userSid, bindings: registrationBindings })
    const carrier = await startWindowsHostCarrier({
      ...options,
      resolveCurrentUserSid: () => userSid,
      publishRegistration: (registration) => { registrationPublisher.publish(registration) },
      startWorker: worker => startWorkerThread({
        generation: options.workerGeneration,
        workerEntry: options.workerEntry,
        policy: worker.policy,
        stopFlag: worker.stopFlag,
        allowedPublisherThumbprints: options.allowedPublisherThumbprints,
        allowedPackageFamilyNames: options.allowedPackageFamilyNames ?? new Set(),
        allowedExecutableDigests: options.allowedExecutableDigests,
        nativeModule: options.nativeModule,
        cancellation,
        maxCancelAttempts: options.maxCancelAttempts,
        waitForCancelRetry: options.waitForCancelRetry,
        startupDeadline: options.startupDeadline,
        exitWithoutHandleDeadline: options.exitWithoutHandleDeadline,
        sessionCleanupDeadline: options.sessionCleanupDeadline,
        openSession: options.openSession,
        onFailure: worker.onFailure,
      }),
    })
    return new WindowsHostTransport(
      carrier,
      ownership,
      options.quiesceOwnedResources,
      options.processFallback,
    )
  } catch (error) {
    if (error instanceof WindowsHostProcessFallbackRequiredError) throw error
    try { await options.quiesceOwnedResources() } catch (quiesceError) {
      const cause = quiesceError instanceof Error
        ? quiesceError
        : new Error('Unknown Windows Host owned-resource shutdown failure')
      const request = { reason: 'owned_resources_stop_failed' as const, cause }
      try { await options.processFallback(request) } catch (fallbackError) {
        throw new WindowsHostProcessFallbackRequiredError(request, fallbackError)
      }
      throw new WindowsHostProcessFallbackRequiredError(request, cause)
    }
    try { ownership.release() } catch (releaseError) {
      const cause = releaseError instanceof Error ? releaseError : new Error('Unknown Windows Host ownership release failure')
      const request = { reason: 'ownership_release_failed' as const, cause }
      try { await options.processFallback(request) } catch (fallbackError) {
        throw new WindowsHostProcessFallbackRequiredError(request, fallbackError)
      }
      throw new WindowsHostProcessFallbackRequiredError(request, cause)
    }
    throw error
  }
}
