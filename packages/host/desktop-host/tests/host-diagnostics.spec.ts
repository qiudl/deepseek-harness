import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHostDiagnostics,
  hostDiagnosticReason,
  hostDiagnosticsFileOperations,
  hostStepRejection,
  type HostDiagnosticsFileOperations,
} from '../src/host-diagnostics.ts'
import { HostAuthorityError } from '../src/types.ts'

const root = String.raw`C:\Slark\env`
const createdAt = Date.UTC(2026, 6, 15, 8, 30)
const temporaryRoots: string[] = []

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-host-diagnostics-'))
  temporaryRoots.push(path)
  return path
}

/**
 * Map the writer's Windows paths onto a real temporary directory so the production
 * filesystem operations run unchanged on every platform.
 */
function mappedOperations(temporary: string, seen: string[] = []): HostDiagnosticsFileOperations {
  const map = (path: string): string => {
    if (!path.startsWith(`${root}\\`)) throw new Error(`unmapped diagnostics path: ${path}`)
    return join(temporary, path.slice(root.length + 1).replaceAll('\\', '/'))
  }
  return {
    ensureDirectory: (path) => { seen.push(path); hostDiagnosticsFileOperations.ensureDirectory(map(path)) },
    append: (path, contents) => { hostDiagnosticsFileOperations.append(map(path), contents) },
    length: path => hostDiagnosticsFileOperations.length(map(path)),
    replace: (source, target) => { hostDiagnosticsFileOperations.replace(map(source), map(target)) },
  }
}

function logFile(temporary: string, suffix = ''): string {
  return join(temporary, 'diagnostics', `host-errors.log${suffix}`)
}

function readLog(temporary: string, suffix = ''): string {
  return readFileSync(logFile(temporary, suffix), 'utf8')
}

function reasons(contents: string): unknown[] {
  return contents.trimEnd().split('\n').map(line => (JSON.parse(line) as Record<string, unknown>)['reason'])
}

describe('Host diagnostics log', () => {
  it('creates the environment diagnostics directory and appends one bounded record per failure', () => {
    const temporary = temporaryRoot()
    const seen: string[] = []
    createHostDiagnostics({ root, now: () => createdAt, fileOperations: mappedOperations(temporary, seen) })
      .record({ event: 'peer-attest', reason: 'publisher_not_allowed' })
    createHostDiagnostics({ root, now: () => createdAt, fileOperations: mappedOperations(temporary, seen) })
      .record({ event: 'control-session', reason: 'unauthorized', method: 'profile.status', status: -2_147_024_891 })

    expect(seen).toEqual([String.raw`C:\Slark\env\diagnostics`, String.raw`C:\Slark\env\diagnostics`])
    expect(readLog(temporary).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>))
      .toEqual([
        { ts: '2026-07-15T08:30:00.000Z', event: 'peer-attest', reason: 'publisher_not_allowed' },
        {
          ts: '2026-07-15T08:30:00.000Z',
          event: 'control-session',
          reason: 'unauthorized',
          method: 'profile.status',
          status: -2_147_024_891,
        },
      ])
  })

  it('falls back to the production filesystem operations when none are injected', () => {
    const diagnostics = createHostDiagnostics({ root, now: () => createdAt })

    expect(typeof diagnostics.record).toBe('function')
  })

  it('defaults the clock so an omitted timestamp source still records one ISO instant', () => {
    const temporary = temporaryRoot()
    const before = Date.now()
    createHostDiagnostics({ root, fileOperations: mappedOperations(temporary) })
      .record({ event: 'peer-attest', reason: 'digest_not_allowed' })

    const instant = Date.parse(String((JSON.parse(readLog(temporary)) as Record<string, unknown>)['ts']))
    expect(instant).toBeGreaterThanOrEqual(before)
    expect(instant).toBeLessThanOrEqual(Date.now())
  })

  it('rotates onto one previous log and never grows either file past the configured bound', () => {
    const temporary = temporaryRoot()
    const diagnostics = createHostDiagnostics({
      root,
      now: () => createdAt,
      maximumBytes: 140,
      fileOperations: mappedOperations(temporary),
    })
    for (const reason of ['owner_sid_mismatch', 'path_invalid', 'digest_not_allowed', 'cleanup_failed']) {
      diagnostics.record({ event: 'peer-attest', reason })
    }

    expect(Buffer.byteLength(readLog(temporary))).toBeLessThanOrEqual(140)
    expect(Buffer.byteLength(readLog(temporary, '.1'))).toBeLessThanOrEqual(140)
    expect(reasons(readLog(temporary))).toEqual(['cleanup_failed'])
    expect(reasons(readLog(temporary, '.1'))).toEqual(['digest_not_allowed'])
    expect(existsSync(logFile(temporary, '.2'))).toBe(false)
  })

  it('appends to an existing log while it still fits the bound', () => {
    const temporary = temporaryRoot()
    hostDiagnosticsFileOperations.ensureDirectory(join(temporary, 'diagnostics'))
    writeFileSync(logFile(temporary), 'previously-written\n')
    createHostDiagnostics({ root, fileOperations: mappedOperations(temporary) })
      .record({ event: 'peer-attest', reason: 'publisher_invalid' })

    const contents = readLog(temporary)
    expect(contents.startsWith('previously-written\n')).toBe(true)
    expect(contents.trimEnd().split('\n').slice(1).map(line => (JSON.parse(line) as Record<string, unknown>)['reason']))
      .toEqual(['publisher_invalid'])
    expect(existsSync(logFile(temporary, '.1'))).toBe(false)
  })

  it('bounds every recorded token and never writes a path, user name, SID, or carrier text', () => {
    const temporary = temporaryRoot()
    createHostDiagnostics({ root, now: () => createdAt, fileOperations: mappedOperations(temporary) })
      .record({
        event: 'peer-attest',
        reason: String.raw`C:\Users\alice\AppData\Local\Slark\slark-daemon.exe not in allowlist`,
        method: 'a'.repeat(512),
      })

    const contents = readLog(temporary)
    const record = JSON.parse(contents) as Record<string, unknown>
    expect(record['reason']).toBe('c')
    expect(record['method']).toBe('a'.repeat(64))
    for (const secret of ['C:\\', '\\', '/', 'Users', 'alice', 'AppData', '.exe', ' ']) {
      expect(contents).not.toContain(secret)
    }
    expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(512)
  })

  it('drops a record whose reason has no safe leading token and writes nothing', () => {
    const temporary = temporaryRoot()
    createHostDiagnostics({ root, now: () => createdAt, fileOperations: mappedOperations(temporary) })
      .record({ event: 'peer-attest', reason: String.raw`\\.\pipe\slark-dsh-host-v1` })

    expect(existsSync(logFile(temporary))).toBe(false)
  })

  it('swallows every filesystem failure instead of failing the Host operation', () => {
    const failures: HostDiagnosticsFileOperations[] = [
      {
        ensureDirectory: () => { throw new Error('ACL denied') },
        append: vi.fn(),
        length: () => undefined,
        replace: vi.fn(),
      },
      {
        ensureDirectory: vi.fn(),
        append: () => { throw new Error('disk full') },
        length: () => undefined,
        replace: vi.fn(),
      },
      {
        ensureDirectory: vi.fn(),
        append: vi.fn(),
        length: () => { throw new Error('stat failed') },
        replace: vi.fn(),
      },
      {
        ensureDirectory: vi.fn(),
        append: vi.fn(),
        length: () => 10_000,
        replace: () => { throw new Error('rename failed') },
      },
      { ensureDirectory: vi.fn(), append: vi.fn(), length: () => 10_000, replace: vi.fn() },
    ]
    for (const fileOperations of failures) {
      const diagnostics = createHostDiagnostics({ root, now: () => createdAt, maximumBytes: 100, fileOperations })
      expect(() => { diagnostics.record({ event: 'control-session', reason: 'unauthorized' }) }).not.toThrow()
    }
  })

  it('rejects a non-Windows environment root and a non-positive byte bound before recording', () => {
    for (const invalidRoot of [
      String.raw`\Slark\env`,
      '/var/lib/slark',
      String.raw`C:\Slark\env:stream`,
      `C:\Slark\env${String.fromCharCode(0)}`,
    ]) {
      expect(() => createHostDiagnostics({ root: invalidRoot })).toThrow(HostAuthorityError)
    }
    for (const maximumBytes of [0, 1.5]) {
      expect(() => createHostDiagnostics({ root, maximumBytes })).toThrow(HostAuthorityError)
    }
  })

  it('names the rejection by authority code, error name, or the unknown fallback', () => {
    expect(hostDiagnosticReason(new HostAuthorityError('profile_mismatch'))).toBe('profile_mismatch')
    expect(hostDiagnosticReason(new TypeError('carrier text'))).toBe('TypeError')
    expect(hostDiagnosticReason('rejected')).toBe('unknown')
  })

  it('prefers the finer local step reason over the wire authority code', () => {
    expect(hostDiagnosticReason(new HostAuthorityError('unavailable', 'restore_selector_invalid')))
      .toBe('restore_selector_invalid')
  })

  it('names the failing local Profile step while preserving the wire authority code', async () => {
    await expect(hostStepRejection(() => 'ready', 'restore_profile_rejected')).resolves.toBe('ready')
    await expect(hostStepRejection(async () => 'ready', 'restore_profile_rejected'))
      .resolves.toBe('ready')

    const named = await hostStepRejection(
      () => { throw new HostAuthorityError('unavailable') },
      'restore_selector_invalid',
    ).catch((error: unknown) => error)
    expect(named).toBeInstanceOf(HostAuthorityError)
    expect((named as HostAuthorityError).code).toBe('unavailable')
    expect((named as HostAuthorityError).diagnosticReason).toBe('restore_selector_invalid')

    const labelled = await hostStepRejection(
      () => { throw new HostAuthorityError('stale', 'restore_profile_missing') },
      'restore_profile_rejected',
    ).catch((error: unknown) => error)
    expect((labelled as HostAuthorityError).code).toBe('stale')
    expect((labelled as HostAuthorityError).diagnosticReason).toBe('restore_profile_missing')

    const carrierText = new TypeError('worker unavailable at C:/Users/alice')
    await expect(hostStepRejection(() => { throw carrierText }, 'restore_profile_rejected'))
      .rejects.toBe(carrierText)
  })
})
