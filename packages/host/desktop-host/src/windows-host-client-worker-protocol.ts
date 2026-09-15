import { win32 } from 'node:path'
import {
  decodeHostControlFrame,
  encodeHostControlFrame,
  type HostControlFrame,
} from '@deepseek-ai/dsh-host-control-protocol'
import { isWindowsDshUserSid } from './windows-named-pipe-policy.ts'
import { assertWindowsWorkerKeys, windowsWorkerRecord } from './windows-host-client-worker-validation.ts'
import type { WindowsPeerEvidence } from './windows-peer-attestor.ts'

const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const PUBLISHER = /^(?:[0-9A-F]{40}|[0-9A-F]{64})$/u
const SHA256 = /^[0-9a-f]{64}$/u

interface Base { readonly version: 1; readonly generation: number }

export type WindowsHostClientWorkerMessage =
  | (Base & { readonly type: 'starting'; readonly threadHandle: bigint })
  | (Base & { readonly type: 'ready'; readonly evidence: WindowsPeerEvidence })
  | (Base & { readonly type: 'request'; readonly sequence: number; readonly frame: string })
  | (Base & { readonly type: 'response'; readonly sequence: number; readonly frame: string })
  | (Base & { readonly type: 'stop' })
  | (Base & { readonly type: 'stopped' })
  | (Base & {
    readonly type: 'failed'
    readonly code: 'trusted_host_not_running' | 'host_unverified'
  })

export class WindowsHostClientWorkerProtocolError extends Error {
  constructor() { super('Invalid Windows Host client Worker message') }
}

function reject(): never { throw new WindowsHostClientWorkerProtocolError() }

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value < INVALID_HANDLE_VALUE
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function frame(input: unknown, direction: 'request' | 'response'): string {
  if (typeof input !== 'string') return reject()
  let decoded: HostControlFrame
  try { decoded = decodeHostControlFrame(input) } catch { return reject() }
  if ((direction === 'request' && decoded.type !== 'request')
    || (direction === 'response' && decoded.type !== 'result' && decoded.type !== 'error')
    || encodeHostControlFrame(decoded) !== input) return reject()
  return input
}

function evidence(input: unknown): WindowsPeerEvidence {
  const value = windowsWorkerRecord(input, reject)
  assertWindowsWorkerKeys(value, [
    'pid',
    'userSid',
    'executablePath',
    'authenticodePublisherThumbprint',
    'executableSignatureDigest',
  ], reject)
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
    || typeof value.userSid !== 'string' || !isWindowsDshUserSid(value.userSid)
    || typeof value.executablePath !== 'string' || !DRIVE_ROOTED_PATH.test(value.executablePath)
    || CONTROL_CHARACTER.test(value.executablePath) || value.executablePath.slice(2).includes(':')
    || win32.normalize(value.executablePath) !== value.executablePath
    || typeof value.authenticodePublisherThumbprint !== 'string'
    || !PUBLISHER.test(value.authenticodePublisherThumbprint)
    || typeof value.executableSignatureDigest !== 'string'
    || !SHA256.test(value.executableSignatureDigest)) return reject()
  return Object.freeze({
    pid: value.pid as number,
    userSid: value.userSid,
    executablePath: value.executablePath,
    authenticodePublisherThumbprint: value.authenticodePublisherThumbprint,
    executableSignatureDigest: value.executableSignatureDigest,
  })
}

/** Strictly decode both halves of the private generation-bound client Worker protocol. */
export function decodeWindowsHostClientWorkerMessage(
  input: unknown,
  expectedGeneration: number,
): WindowsHostClientWorkerMessage {
  const value = windowsWorkerRecord(input, reject)
  if (value.version !== 1 || value.generation !== expectedGeneration
    || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1
    || typeof value.type !== 'string') return reject()
  const base = { version: 1 as const, generation: expectedGeneration }
  if (value.type === 'starting') {
    assertWindowsWorkerKeys(value, ['version', 'type', 'generation', 'threadHandle'], reject)
    if (!validHandle(value.threadHandle)) return reject()
    return Object.freeze({ ...base, type: 'starting', threadHandle: value.threadHandle })
  }
  if (value.type === 'ready') {
    assertWindowsWorkerKeys(value, ['version', 'type', 'generation', 'evidence'], reject)
    return Object.freeze({ ...base, type: 'ready', evidence: evidence(value.evidence) })
  }
  if (value.type === 'request' || value.type === 'response') {
    assertWindowsWorkerKeys(value, ['version', 'type', 'generation', 'sequence', 'frame'], reject)
    if (!validSequence(value.sequence)) return reject()
    return Object.freeze({
      ...base,
      type: value.type,
      sequence: value.sequence,
      frame: frame(value.frame, value.type),
    })
  }
  if (value.type === 'failed') {
    assertWindowsWorkerKeys(value, ['version', 'type', 'generation', 'code'], reject)
    if (value.code !== 'trusted_host_not_running' && value.code !== 'host_unverified') return reject()
    return Object.freeze({ ...base, type: 'failed', code: value.code })
  }
  if (value.type === 'stop' || value.type === 'stopped') {
    assertWindowsWorkerKeys(value, ['version', 'type', 'generation'], reject)
    return Object.freeze({ ...base, type: value.type })
  }
  return reject()
}
