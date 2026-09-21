import { EventEmitter } from 'node:events'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'

interface ExecResult { readonly stdout: string; readonly stderr: string }

const native = vi.hoisted(() => ({
  execFile: vi.fn<(file: string, args: readonly string[], options?: unknown) => Promise<ExecResult>>(),
  load: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = vi.fn()
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: Parameters<typeof native.execFile>) => native.execFile(...args),
  })
  return { ...actual, execFile }
})

vi.mock('koffi', () => ({ default: { load: native.load } }))

import { attestMacOSListener, DshWebProfileWorkerFactory } from '../src/dsh-web-profile-worker.ts'
import { createMacOSPeerAttestor, readExecutable } from '../src/macos-peer-attestor.ts'
import { HostAuthorityError } from '../src/types.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  native.execFile.mockReset()
  native.load.mockReset()
})

function executable(contents = 'signed daemon fixture'): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-peer-default-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const path = join(root, 'slark-daemon')
  writeFileSync(path, contents, { mode: 0o700 })
  return path
}

function configureNativeBindings(path: string, team: string | null = 'TEAM123', procFallback = false): void {
  const uid = process.getuid?.() ?? 501
  native.load.mockImplementation((libraryPath: string) => ({
    func(signature: string) {
      if (libraryPath.endsWith('libSystem.B.dylib') && signature.startsWith('int getpeereid')) {
        return (_fd: number, peerUid: Uint32Array) => { peerUid[0] = uid; return 0 }
      }
      if (libraryPath.endsWith('libSystem.B.dylib') && signature.startsWith('int getsockopt')) {
        return (_fd: number, _level: number, _name: number, pid: Int32Array) => { pid[0] = 42; return 0 }
      }
      if (libraryPath.endsWith('libproc.dylib') && signature.startsWith('int proc_pidpath')) {
        return (_pid: number, buffer: Buffer) => procFallback ? 0 : buffer.write(path)
      }
      throw new Error(`unexpected native function: ${signature}`)
    },
  }))
  native.execFile.mockImplementation(async (file: string, args: readonly string[]) => {
    if (file === '/usr/sbin/lsof') return { stdout: `p42\nftxt\nn${path}\n`, stderr: '' }
    if (file !== '/usr/bin/codesign') throw new Error(`unexpected executable: ${file}`)
    const candidate = args.at(-1)
    expect(candidate).not.toBe(path)
    if (candidate === undefined) throw new Error('codesign executable path is missing')
    expect(readFileSync(candidate, 'utf8')).toBe('signed daemon fixture')
    return { stdout: '', stderr: args[0] === '--display' && team !== null ? `TeamIdentifier=${team}\n` : '' }
  })
}

it('attests the default macOS listener and rejects a listener owned by another process', async () => {
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  await expect(attestMacOSListener(42, 'http://127.0.0.1:4123')).rejects.toMatchObject({ code: 'unavailable' })

  platform.mockReturnValue('darwin')
  native.execFile.mockResolvedValueOnce({ stdout: 'p42\n', stderr: '' })
  await expect(attestMacOSListener(42, 'http://127.0.0.1:4123')).resolves.toBeUndefined()
  expect(native.execFile).toHaveBeenCalledWith('/usr/sbin/lsof', [
    '-nP', '-a', '-p', '42', '-iTCP@127.0.0.1:4123', '-sTCP:LISTEN', '-Fn',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 })

  native.execFile.mockResolvedValueOnce({ stdout: 'p41\n', stderr: '' })
  await expect(attestMacOSListener(42, 'http://127.0.0.1:4123')).rejects.toBeInstanceOf(HostAuthorityError)
})

it('uses the default listener attestor while accepting an exact authenticated readiness line', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  native.execFile.mockResolvedValue({ stdout: 'p42\n', stderr: '' })
  const cookie = `dsh-auth-${'a'.repeat(43)}=v1.${'b'.repeat(8)}.${'c'.repeat(43)}; Max-Age=60; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; SameSite=Strict`
  const cancel = vi.fn(async () => undefined)
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({ status: 303, headers: { get: () => '/', getSetCookie: () => [cookie] }, body: { cancel } })
    .mockResolvedValueOnce({ status: 401, body: { cancel } })
    .mockResolvedValueOnce({ status: 200, body: { cancel } }))
  const stdout = new PassThrough()
  onTestFinished(() => { stdout.destroy() })
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess
  const factory = new DshWebProfileWorkerFactory({
    nodeExecutablePath: process.execPath,
    dshEntrypointPath: process.execPath,
  })
  const pending = (factory as unknown as {
    waitForOrigin(child: ChildProcess): Promise<unknown>
  }).waitForOrigin(child)
  stdout.write('dsh web: http://127.0.0.1:4123/?token=fixture\n')
  await expect(pending).resolves.toEqual({
    origin: 'http://127.0.0.1:4123',
    bootstrapCookie: { name: `dsh-auth-${'a'.repeat(43)}`, value: `v1.${'b'.repeat(8)}.${'c'.repeat(43)}` },
  })
  expect(cancel).toHaveBeenCalledTimes(3)
})

it('assembles the default native bindings on every host without invoking real platform commands', async () => {
  const path = executable()
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const unsupported = createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(['TEAM123']) })
  await expect(unsupported({ _handle: { fd: 9 } } as never)).rejects.toMatchObject({ code: 'unavailable' })

  platform.mockReturnValue('darwin')
  configureNativeBindings(path)
  const attest = createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(['TEAM123']) })
  await expect(attest({ _handle: { fd: 9 } } as never)).resolves.toMatchObject({ uid: process.getuid?.() ?? 501 })
  expect(native.load).toHaveBeenCalledWith('/usr/lib/libSystem.B.dylib')
  expect(native.load).toHaveBeenCalledWith('/usr/lib/libproc.dylib')
})

it('uses the default lsof fallback and rejects missing or malformed Team Identifiers', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  const path = executable()
  configureNativeBindings(path, 'TEAM123', true)
  const trusted = createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(['TEAM123']) })
  await expect(trusted({ _handle: { fd: 9 } } as never)).resolves.toMatchObject({ uid: process.getuid?.() ?? 501 })

  configureNativeBindings(path, null)
  await expect(createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(['TEAM123']) })({ _handle: { fd: 9 } } as never))
    .rejects.toBeInstanceOf(HostAuthorityError)
  configureNativeBindings(path, 'bad team')
  await expect(createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(['TEAM123']) })({ _handle: { fd: 9 } } as never))
    .rejects.toBeInstanceOf(HostAuthorityError)
})

it('rejects executable reads that are shorter or longer than the attested size', () => {
  const path = executable('ab')
  const fd = openSync(path, 'r')
  try {
    expect(() => readExecutable(fd, Number.NaN)).toThrow(HostAuthorityError)
    expect(() => readExecutable(fd, 3)).toThrow(HostAuthorityError)
    expect(() => readExecutable(fd, 1)).toThrow(HostAuthorityError)
  } finally {
    closeSync(fd)
  }
})
