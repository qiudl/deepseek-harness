import { HostAuthorityError } from './types.ts'
import type { WindowsWorkerStopFlag } from './windows-worker-io-cancellation.ts'

const PIPE_PATH = /^\\\\\.\\pipe\\slark-dsh-host-v1-[0-9a-f]{64}$/u
const PUBLISHER = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u
const SHA256 = /^[0-9a-f]{64}$/u
const MAX_CONNECT_TIMEOUT_MS = 30_000

export interface WindowsHostClientWorkerBootData {
  readonly version: 1
  readonly generation: number
  readonly pipePath: string
  readonly stopFlagBuffer: SharedArrayBuffer
  readonly connectTimeoutMs: number
  readonly allowedPublisherThumbprints: readonly string[]
  readonly allowedExecutableDigests: readonly string[]
}

export interface CreateWindowsHostClientWorkerBootDataOptions {
  readonly generation: number
  readonly pipePath: string
  readonly stopFlag: WindowsWorkerStopFlag
  readonly connectTimeoutMs: number
  readonly allowedPublisherThumbprints: ReadonlySet<string>
  readonly allowedExecutableDigests: ReadonlySet<string>
}

function invalid(): never { throw new Error('Invalid Windows Host client Worker boot data') }

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid()
  return input as Record<string, unknown>
}

function exactKeys(input: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(input).sort()
  const canonical = [...expected].sort()
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) invalid()
}

function anchors(input: unknown, pattern: RegExp): readonly string[] {
  if (!Array.isArray(input) || input.length === 0
    || input.some(value => typeof value !== 'string' || !pattern.test(value))) invalid()
  const values = input as string[]
  const sorted = [...values].sort()
  if (new Set(values).size !== values.length
    || values.some((value, index) => value !== sorted[index])) invalid()
  return Object.freeze([...values])
}

/** Strictly decode the trust roots accepted by one native client Worker generation. */
export function decodeWindowsHostClientWorkerBootData(input: unknown): WindowsHostClientWorkerBootData {
  const value = record(input)
  exactKeys(value, [
    'version',
    'generation',
    'pipePath',
    'stopFlagBuffer',
    'connectTimeoutMs',
    'allowedPublisherThumbprints',
    'allowedExecutableDigests',
  ])
  if (value.version !== 1 || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || typeof value.pipePath !== 'string' || !PIPE_PATH.test(value.pipePath)
    || !(value.stopFlagBuffer instanceof SharedArrayBuffer) || value.stopFlagBuffer.byteLength !== 4
    || !Number.isSafeInteger(value.connectTimeoutMs) || (value.connectTimeoutMs as number) < 1
    || (value.connectTimeoutMs as number) > MAX_CONNECT_TIMEOUT_MS) invalid()
  return Object.freeze({
    version: 1,
    generation: value.generation as number,
    pipePath: value.pipePath,
    stopFlagBuffer: value.stopFlagBuffer,
    connectTimeoutMs: value.connectTimeoutMs as number,
    allowedPublisherThumbprints: anchors(value.allowedPublisherThumbprints, PUBLISHER),
    allowedExecutableDigests: anchors(value.allowedExecutableDigests, SHA256),
  })
}

/** Build and revalidate the only structured-clone payload accepted by the client Worker. */
export function createWindowsHostClientWorkerBootData(
  options: CreateWindowsHostClientWorkerBootDataOptions,
): WindowsHostClientWorkerBootData {
  try {
    return decodeWindowsHostClientWorkerBootData({
      version: 1,
      generation: options.generation,
      pipePath: options.pipePath,
      stopFlagBuffer: options.stopFlag.buffer,
      connectTimeoutMs: options.connectTimeoutMs,
      allowedPublisherThumbprints: [...options.allowedPublisherThumbprints].sort(),
      allowedExecutableDigests: [...options.allowedExecutableDigests].sort(),
    })
  } catch {
    throw new HostAuthorityError('invalid_input')
  }
}
