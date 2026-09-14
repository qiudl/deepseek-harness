import { win32 } from 'node:path'
import { HostAuthorityError } from './types.ts'
import type { WindowsNamedPipePolicy } from './windows-named-pipe-policy.ts'
import { isWindowsDshUserSid } from './windows-named-pipe-policy.ts'
import type { WindowsVaultNativeModulePin } from './windows-pinned-vault-native.ts'
import type { WindowsWorkerStopFlag } from './windows-worker-io-cancellation.ts'

const PIPE_PATH = /^\\\\\.\\pipe\\slark-dsh-host-v1-[0-9a-f]{64}$/u
const SECURITY_DESCRIPTOR = /^O:(S-[0-9-]+)D:P\(A;;GRGW;;;(S-[0-9-]+)\)$/u
const PUBLISHER = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u
const PACKAGE_FAMILY_NAME = /^[A-Za-z0-9.-]+_[A-Za-z0-9]+$/u
const SHA256 = /^[0-9a-f]{64}$/u
const PIPE_OPEN_MODE = 0x0008_0003
const PIPE_MODE = 0x0000_0008

/** Canonical structured-clone payload owned by one Windows pipe Worker generation. */
export interface WindowsHostPipeWorkerBootData {
  readonly version: 1
  readonly generation: number
  readonly policy: WindowsNamedPipePolicy
  readonly stopFlagBuffer: SharedArrayBuffer
  readonly allowedPublisherThumbprints: readonly string[]
  readonly allowedPackageFamilyNames: readonly string[]
  readonly allowedExecutableDigests: readonly string[]
  readonly nativeModule: WindowsVaultNativeModulePin
}

export interface CreateWindowsHostPipeWorkerBootDataOptions {
  readonly generation: number
  readonly policy: WindowsNamedPipePolicy
  readonly stopFlag: WindowsWorkerStopFlag
  readonly allowedPublisherThumbprints: ReadonlySet<string>
  readonly allowedPackageFamilyNames?: ReadonlySet<string>
  readonly allowedExecutableDigests: ReadonlySet<string>
  readonly nativeModule: WindowsVaultNativeModulePin
}

function invalid(): never { throw new Error('Invalid Windows Host Worker boot data') }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) invalid()
}

function canonicalAnchors(value: unknown, pattern: RegExp, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some(anchor => typeof anchor !== 'string'
    || !pattern.test(anchor))) return invalid()
  const anchors = value as string[]
  const sorted = [...anchors].sort()
  if (new Set(anchors).size !== anchors.length || anchors.some((anchor, index) => anchor !== sorted[index])) invalid()
  return Object.freeze([...anchors])
}

function canonicalPolicy(value: unknown): WindowsNamedPipePolicy {
  const policy = record(value)
  exactKeys(policy, ['path', 'securityDescriptor', 'openMode', 'pipeMode', 'maxInstances'])
  const descriptor = typeof policy.securityDescriptor === 'string'
    ? SECURITY_DESCRIPTOR.exec(policy.securityDescriptor)
    : null
  if (typeof policy.path !== 'string' || !PIPE_PATH.test(policy.path)
    || descriptor === null || descriptor[1] !== descriptor[2]
    || descriptor[1] === undefined || !isWindowsDshUserSid(descriptor[1])
    || policy.openMode !== PIPE_OPEN_MODE || policy.pipeMode !== PIPE_MODE
    || policy.maxInstances !== 1) return invalid()
  return Object.freeze({
    path: policy.path,
    securityDescriptor: policy.securityDescriptor as string,
    openMode: PIPE_OPEN_MODE,
    pipeMode: PIPE_MODE,
    maxInstances: 1,
  })
}

function canonicalNativeModule(value: unknown): WindowsVaultNativeModulePin {
  const native = record(value)
  exactKeys(native, ['path', 'sha256'])
  if (typeof native.path !== 'string' || !win32.isAbsolute(native.path)
    || win32.normalize(native.path) !== native.path || win32.basename(native.path) !== 'koffi.node'
    || typeof native.sha256 !== 'string' || !SHA256.test(native.sha256)) return invalid()
  return Object.freeze({ path: native.path, sha256: native.sha256 })
}

/** Strictly decode the only payload accepted by the native Windows Worker entry. */
export function decodeWindowsHostPipeWorkerBootData(input: unknown): WindowsHostPipeWorkerBootData {
  const value = record(input)
  exactKeys(value, [
    'version',
    'generation',
    'policy',
    'stopFlagBuffer',
    'allowedPublisherThumbprints',
    'allowedPackageFamilyNames',
    'allowedExecutableDigests',
    'nativeModule',
  ])
  if (value.version !== 1 || !Number.isSafeInteger(value.generation)
    || (value.generation as number) < 1
    || !(value.stopFlagBuffer instanceof SharedArrayBuffer)
    || value.stopFlagBuffer.byteLength !== 4) return invalid()
  const allowedPublisherThumbprints = canonicalAnchors(value.allowedPublisherThumbprints, PUBLISHER, true)
  const allowedPackageFamilyNames = canonicalAnchors(value.allowedPackageFamilyNames, PACKAGE_FAMILY_NAME, true)
  if ((allowedPublisherThumbprints.length > 0) === (allowedPackageFamilyNames.length > 0)) invalid()
  return Object.freeze({
    version: 1,
    generation: value.generation as number,
    policy: canonicalPolicy(value.policy),
    stopFlagBuffer: value.stopFlagBuffer,
    allowedPublisherThumbprints,
    allowedPackageFamilyNames,
    allowedExecutableDigests: canonicalAnchors(value.allowedExecutableDigests, SHA256),
    nativeModule: canonicalNativeModule(value.nativeModule),
  }) satisfies WindowsHostPipeWorkerBootData
}

/** Build and revalidate the payload before crossing the Worker structured-clone boundary. */
export function createWindowsHostPipeWorkerBootData(
  options: CreateWindowsHostPipeWorkerBootDataOptions,
): WindowsHostPipeWorkerBootData {
  try {
    return decodeWindowsHostPipeWorkerBootData({
      version: 1,
      generation: options.generation,
      policy: options.policy,
      stopFlagBuffer: options.stopFlag.buffer,
      allowedPublisherThumbprints: [...options.allowedPublisherThumbprints].sort(),
      allowedPackageFamilyNames: [...(options.allowedPackageFamilyNames ?? [])].sort(),
      allowedExecutableDigests: [...options.allowedExecutableDigests].sort(),
      nativeModule: options.nativeModule,
    })
  } catch {
    throw new HostAuthorityError('invalid_input')
  }
}
