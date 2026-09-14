import { describe, expect, it, vi } from 'vitest'
import { loadWindowsPeerAttestor } from '../src/windows-peer-attestor-native.ts'
import type { WindowsExecutableTrustOperations } from '../src/windows-peer-process-native.ts'

const path = String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`
const publisher = 'A'.repeat(64)
const digest = 'a'.repeat(64)

describe('Windows native peer-attestor composition', () => {
  it('assembles every native proof and closes both stable handles after success', async () => {
    const closed: bigint[] = []
    const verifyAuthenticodePublisher = vi.fn(() => publisher)
    const digestExecutable = vi.fn(() => digest)
    const loadProcessNative = vi.fn(async (trust: WindowsExecutableTrustOperations) => ({
      getNamedPipeClientProcessId: vi.fn(() => 42),
      getNamedPipeServerProcessId: vi.fn(() => 84),
      openProcess: vi.fn(() => 101n),
      currentUserSid: vi.fn(() => 'S-1-5-21-1-2-3-1001'),
      processOwnerSid: vi.fn(() => 'S-1-5-21-1-2-3-1001'),
      processPackageIdentity: vi.fn(() => ({
        familyName: 'Slark.Desktop_1234567890abc',
        packagePath: String.raw`C:\Program Files\WindowsApps\Slark.Desktop_1.0.0.0_x64__1234567890abc`,
      })),
      queryProcessImagePath: vi.fn(() => path),
      openExecutableForVerification: vi.fn(() => 202n),
      finalExecutablePath: vi.fn(() => String.raw`\\?\C:\Program Files\Slark\slark-daemon-windows-x64.exe`),
      equalWindowsPath: vi.fn(() => true),
      verifyAuthenticodePublisher: (handle: bigint, canonicalPath: string) =>
        trust.verifyAuthenticodePublisher(handle, canonicalPath),
      digestExecutable: (handle: bigint) => trust.digestExecutable(handle),
      closeHandle: vi.fn((handle: bigint) => { closed.push(handle) }),
    }))
    const attest = await loadWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([digest]),
    }, {
      loadAuthenticode: async () => verifyAuthenticodePublisher,
      loadDigest: async () => digestExecutable,
      loadProcessNative,
    })

    await expect(attest(91n)).resolves.toMatchObject({
      pid: 42,
      userSid: 'S-1-5-21-1-2-3-1001',
      executablePath: path,
      authenticodePublisherThumbprint: publisher,
      executableSignatureDigest: digest,
    })
    expect(loadProcessNative).toHaveBeenCalledOnce()
    expect(verifyAuthenticodePublisher).toHaveBeenCalledWith(202n, path)
    expect(digestExecutable).toHaveBeenCalledWith(202n)
    expect(closed).toEqual([202n, 101n])
  })

  it('selects the server PID proof for a client-owned named-pipe connection', async () => {
    const clientPid = vi.fn(() => 42)
    const serverPid = vi.fn(() => 84)
    const openProcess = vi.fn(() => 101n)
    const attest = await loadWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([digest]),
      peerProcessRole: 'server',
      platform: 'win32',
      arch: 'x64',
      isMainThread: false,
    }, {
      loadAuthenticode: async () => () => publisher,
      loadDigest: async () => () => digest,
      loadProcessNative: async () => ({
        getNamedPipeClientProcessId: clientPid,
        getNamedPipeServerProcessId: serverPid,
        openProcess,
        currentUserSid: vi.fn(() => 'S-1-5-21-1-2-3-1001'),
        processOwnerSid: vi.fn(() => 'S-1-5-21-1-2-3-1001'),
        processPackageIdentity: vi.fn(() => ({
          familyName: 'Slark.Desktop_1234567890abc',
          packagePath: String.raw`C:\Program Files\WindowsApps\Slark.Desktop_1.0.0.0_x64__1234567890abc`,
        })),
        queryProcessImagePath: vi.fn(() => path),
        openExecutableForVerification: vi.fn(() => 202n),
        finalExecutablePath: vi.fn(() => String.raw`\\?\C:\Program Files\Slark\slark-daemon-windows-x64.exe`),
        equalWindowsPath: vi.fn(() => true),
        verifyAuthenticodePublisher: vi.fn(() => publisher),
        digestExecutable: vi.fn(() => digest),
        closeHandle: vi.fn(),
      }),
    })

    await expect(attest(91n)).resolves.toMatchObject({ pid: 84 })
    expect(serverPid).toHaveBeenCalledTimes(2)
    expect(clientPid).not.toHaveBeenCalled()
    expect(openProcess).toHaveBeenCalledWith(84)
  })

  it('forwards one Windows x64 worker boundary to every loader', async () => {
    const calls: string[] = []
    const runtime = { platform: 'win32', arch: 'x64', isMainThread: false } as const
    await loadWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([digest]),
      ...runtime,
    }, {
      loadAuthenticode: async (received) => { calls.push(`auth:${JSON.stringify(received)}`); return () => publisher },
      loadDigest: async (received) => { calls.push(`digest:${JSON.stringify(received)}`); return () => digest },
      loadProcessNative: async (_trust, received) => {
        calls.push(`process:${JSON.stringify(received)}`)
        throw new Error('stop after boundary check')
      },
    }).catch(() => undefined)
    expect(calls).toEqual([
      `auth:${JSON.stringify(runtime)}`,
      `digest:${JSON.stringify(runtime)}`,
      `process:${JSON.stringify(runtime)}`,
    ])
  })
})
