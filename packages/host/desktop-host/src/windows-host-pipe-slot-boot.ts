import { HostAuthorityError } from './types.ts'
import type { WindowsNamedPipePolicy } from './windows-named-pipe-policy.ts'
import type { WindowsVaultNativeModulePin } from './windows-pinned-vault-native.ts'
import {
  assertWindowsHostBootExactKeys,
  canonicalWindowsEnvironmentRoot,
  canonicalWindowsExecutableDigests,
  canonicalWindowsNativeModulePin,
  canonicalWindowsPipePolicy,
  canonicalWindowsPublisherThumbprints,
  windowsHostBootRecord,
} from './windows-host-pipe-worker-boot.ts'
import type { WindowsHostPipeWorkerBootData } from './windows-host-pipe-worker-boot.ts'
import type { WindowsWorkerStopFlag } from './windows-worker-io-cancellation.ts'

/**
 * Canonical structured-clone payload owned by one per-connection slot thread.
 * A slot reuses the generation's trust anchors and stop flag but creates its own pipe
 * instance; only the first slot may claim FILE_FLAG_FIRST_PIPE_INSTANCE.
 */
export interface WindowsHostPipeSlotBootData {
  readonly version: 1
  readonly role: 'slot'
  readonly generation: number
  readonly firstInstance: boolean
  readonly policy: WindowsNamedPipePolicy
  readonly stopFlagBuffer: SharedArrayBuffer
  readonly allowedPublisherThumbprints: readonly string[]
  readonly allowedExecutableDigests: readonly string[]
  readonly nativeModule: WindowsVaultNativeModulePin
  readonly diagnosticsRoot: string
}

/** Strictly decode the only payload accepted by a per-connection slot thread. */
export function decodeWindowsHostPipeSlotBootData(input: unknown): WindowsHostPipeSlotBootData {
  const value = windowsHostBootRecord(input)
  assertWindowsHostBootExactKeys(value, [
    'version',
    'role',
    'generation',
    'firstInstance',
    'policy',
    'stopFlagBuffer',
    'allowedPublisherThumbprints',
    'allowedExecutableDigests',
    'nativeModule',
    'diagnosticsRoot',
  ])
  if (value.version !== 1 || value.role !== 'slot' || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1 || typeof value.firstInstance !== 'boolean'
    || !(value.stopFlagBuffer instanceof SharedArrayBuffer)
    || value.stopFlagBuffer.byteLength !== 4) {
    throw new Error('Invalid Windows Host Worker boot data')
  }
  return Object.freeze({
    version: 1,
    role: 'slot',
    generation: value.generation as number,
    firstInstance: value.firstInstance,
    policy: canonicalWindowsPipePolicy(value.policy),
    stopFlagBuffer: value.stopFlagBuffer,
    allowedPublisherThumbprints: canonicalWindowsPublisherThumbprints(value.allowedPublisherThumbprints),
    allowedExecutableDigests: canonicalWindowsExecutableDigests(value.allowedExecutableDigests),
    nativeModule: canonicalWindowsNativeModulePin(value.nativeModule),
    diagnosticsRoot: canonicalWindowsEnvironmentRoot(value.diagnosticsRoot),
  })
}

/**
 * Derive one slot payload from the decoded generation boot data.
 * @param boot - canonical Worker-generation boot data received from the parent.
 * @param firstInstance - whether this slot creates the generation's first pipe instance.
 * @param stopFlag - the shared stop flag owning the transferred buffer.
 * @returns a revalidated payload for the slot thread boundary.
 */
export function createWindowsHostPipeSlotBootData(
  boot: WindowsHostPipeWorkerBootData,
  firstInstance: boolean,
  stopFlag: WindowsWorkerStopFlag,
): WindowsHostPipeSlotBootData {
  try {
    return decodeWindowsHostPipeSlotBootData({
      version: 1,
      role: 'slot',
      generation: boot.generation,
      firstInstance,
      policy: boot.policy,
      stopFlagBuffer: stopFlag.buffer,
      allowedPublisherThumbprints: boot.allowedPublisherThumbprints,
      allowedExecutableDigests: boot.allowedExecutableDigests,
      nativeModule: boot.nativeModule,
      diagnosticsRoot: boot.diagnosticsRoot,
    })
  } catch {
    throw new HostAuthorityError('invalid_input')
  }
}
