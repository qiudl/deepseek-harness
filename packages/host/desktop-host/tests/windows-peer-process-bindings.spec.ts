import { describe, expect, it, vi } from 'vitest'
import { HostAuthorityError } from '../src/index.ts'
import {
  createWindowsPeerProcessBindings,
  createWindowsServerProcessBindings,
} from '../src/windows-peer-process-bindings.ts'

const executablePath = String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`

function api(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  return {
    calls,
    native: {
      getNamedPipeClientProcessId: vi.fn((_pipe: bigint) => { calls.push('pipe:pid'); return 42 }),
      getNamedPipeServerProcessId: vi.fn((_pipe: bigint) => { calls.push('pipe:server-pid'); return 84 }),
      openProcess: vi.fn((_pid: number) => { calls.push('process:open'); return 101n }),
      currentUserSid: vi.fn(() => 'S-1-5-21-1000-2000-3000-1001'),
      processOwnerSid: vi.fn((_handle: bigint) => 'S-1-5-21-1000-2000-3000-1001'),
      queryProcessImagePath: vi.fn((_handle: bigint) => {
        calls.push('process:path')
        return executablePath
      }),
      openExecutableForVerification: vi.fn((_path: string) => {
        calls.push('image:open')
        return 202n
      }),
      finalExecutablePath: vi.fn((_handle: bigint) => {
        calls.push('image:path')
        return String.raw`\\?\C:\Program Files\Slark\slark-daemon-windows-x64.exe`
      }),
      equalWindowsPath: vi.fn((left: string, right: string) => left.toLowerCase() === right.toLowerCase()),
      verifyAuthenticodePublisher: vi.fn((_handle: bigint, _path: string) => 'A'.repeat(64)),
      digestExecutable: vi.fn((_handle: bigint) => 'a'.repeat(64)),
      closeHandle: vi.fn((handle: bigint) => { calls.push(`close:${handle}`) }),
      ...overrides,
    },
  }
}

describe('Windows peer process stable-image bindings', () => {
  it('binds pipe PID to one process handle and double-checks one locked image handle', async () => {
    const fixture = api()
    const bindings = createWindowsPeerProcessBindings(fixture.native)
    await expect(bindings.openClientProcess(91n)).resolves.toEqual({ pid: 42, handle: 101n })
    await expect(bindings.openProcessExecutable(101n)).resolves.toEqual({
      handle: 202n,
      path: executablePath,
    })
    expect(fixture.calls).toEqual([
      'pipe:pid', 'process:open', 'pipe:pid',
      'process:path', 'image:open', 'image:path', 'process:path',
    ])
    expect(fixture.native.equalWindowsPath).toHaveBeenNthCalledWith(1, executablePath, executablePath)
    expect(fixture.native.equalWindowsPath).toHaveBeenNthCalledWith(2, executablePath, executablePath)
    await expect(bindings.verifyAuthenticodePublisher(202n)).resolves.toBe('A'.repeat(64))
    expect(fixture.native.verifyAuthenticodePublisher).toHaveBeenCalledWith(202n, executablePath)
  })

  it('binds a client-owned pipe handle to the server PID without trusting the client PID API', async () => {
    const fixture = api()
    const bindings = createWindowsServerProcessBindings(fixture.native)
    await expect(bindings.openClientProcess(91n)).resolves.toEqual({ pid: 84, handle: 101n })
    expect(fixture.native.getNamedPipeServerProcessId).toHaveBeenCalledTimes(2)
    expect(fixture.native.getNamedPipeClientProcessId).not.toHaveBeenCalled()
    expect(fixture.native.openProcess).toHaveBeenCalledWith(84)
  })

  it('closes a newly opened server process when the connected server PID changes', async () => {
    const fixture = api({
      getNamedPipeServerProcessId: vi.fn()
        .mockReturnValueOnce(84)
        .mockReturnValueOnce(85),
    })
    await expect(createWindowsServerProcessBindings(fixture.native).openClientProcess(91n))
      .rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(101n)
  })

  it('closes the opened image when the process path changes during acquisition', async () => {
    let reads = 0
    const fixture = api({
      queryProcessImagePath: vi.fn(() => {
        reads += 1
        return reads === 1 ? executablePath : String.raw`C:\Temp\replaced.exe`
      }),
    })
    const bindings = createWindowsPeerProcessBindings(fixture.native)
    await expect(bindings.openProcessExecutable(101n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.closeHandle).toHaveBeenCalledOnce()
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(202n)
  })

  it('closes a newly opened process when the connected pipe PID changes', async () => {
    let reads = 0
    const fixture = api({
      getNamedPipeClientProcessId: vi.fn(() => {
        reads += 1
        return reads === 1 ? 42 : 43
      }),
    })
    await expect(createWindowsPeerProcessBindings(fixture.native).openClientProcess(91n))
      .rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(101n)

    const failedRecheck = api({
      getNamedPipeClientProcessId: vi.fn()
        .mockReturnValueOnce(42)
        .mockImplementationOnce(() => { throw new Error('pipe disconnected') }),
    })
    await expect(createWindowsPeerProcessBindings(failedRecheck.native).openClientProcess(91n))
      .rejects.toBeInstanceOf(HostAuthorityError)
    expect(failedRecheck.native.closeHandle).toHaveBeenCalledWith(101n)
  })

  it('rejects a final handle path mismatch and still closes the image handle', async () => {
    const fixture = api({
      finalExecutablePath: vi.fn(() => String.raw`\\?\C:\Temp\other.exe`),
    })
    await expect(createWindowsPeerProcessBindings(fixture.native).openProcessExecutable(101n))
      .rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(202n)
  })

  it('requires the native Windows path comparator to return boolean true', async () => {
    const fixture = api({ equalWindowsPath: vi.fn(() => 1) })
    await expect(createWindowsPeerProcessBindings(fixture.native as never).openProcessExecutable(101n))
      .rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(202n)
  })

  it('rejects malformed PID, handles, UNC/device paths, and alternate streams before trust use', async () => {
    for (const malformed of [0, -1, Number.NaN]) {
      const fixture = api({ getNamedPipeClientProcessId: vi.fn(() => malformed) })
      await expect(createWindowsPeerProcessBindings(fixture.native).openClientProcess(91n))
        .rejects.toBeInstanceOf(HostAuthorityError)
      expect(fixture.native.openProcess).not.toHaveBeenCalled()
    }

    for (const path of [
      String.raw`\\server\share\daemon.exe`,
      String.raw`\\?\UNC\server\share\daemon.exe`,
      String.raw`C:\Program Files\Slark\daemon.exe:payload`,
      String.raw`C:\Program Files\Slark\..\daemon.exe`,
    ]) {
      const fixture = api({ queryProcessImagePath: vi.fn(() => path) })
      await expect(createWindowsPeerProcessBindings(fixture.native).openProcessExecutable(101n))
        .rejects.toBeInstanceOf(HostAuthorityError)
      expect(fixture.native.openExecutableForVerification).not.toHaveBeenCalled()
    }
  })

  it('does not leak a valid process or image handle returned alongside malformed native facts', async () => {
    const invalidProcess = api({ openProcess: vi.fn(() => 0xFFFF_FFFF_FFFF_FFFFn) })
    await expect(createWindowsPeerProcessBindings(invalidProcess.native).openClientProcess(91n))
      .rejects.toBeInstanceOf(HostAuthorityError)

    const invalidFinalPath = api({ finalExecutablePath: vi.fn(() => '') })
    await expect(createWindowsPeerProcessBindings(invalidFinalPath.native).openProcessExecutable(101n))
      .rejects.toBeInstanceOf(HostAuthorityError)
    expect(invalidFinalPath.native.closeHandle).toHaveBeenCalledWith(202n)
  })

  it('keeps the verified path bound to the image handle for later signature and digest calls', async () => {
    const fixture = api()
    const bindings = createWindowsPeerProcessBindings(fixture.native)
    await bindings.openProcessExecutable(101n)
    await expect(bindings.digestExecutable(202n)).resolves.toBe('a'.repeat(64))
    await expect(bindings.verifyAuthenticodePublisher(999n)).rejects.toBeInstanceOf(HostAuthorityError)
    await expect(bindings.digestExecutable(999n)).rejects.toBeInstanceOf(HostAuthorityError)
    await bindings.closeHandle(202n)
    await expect(bindings.digestExecutable(202n)).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('forwards SID queries through the worker boundary', async () => {
    const fixture = api()
    const bindings = createWindowsPeerProcessBindings(fixture.native)
    expect(bindings.currentUserSid()).toBe('S-1-5-21-1000-2000-3000-1001')
    expect(bindings.processOwnerSid(101n)).toBe('S-1-5-21-1000-2000-3000-1001')
    expect(fixture.native.processOwnerSid).toHaveBeenCalledWith(101n)
  })

  it('rejects invalid and aliased handles at every ownership boundary', async () => {
    for (const pipe of [0n, -1n, 0xFFFF_FFFF_FFFF_FFFFn]) {
      const fixture = api()
      await expect(createWindowsPeerProcessBindings(fixture.native).openClientProcess(pipe))
        .rejects.toBeInstanceOf(HostAuthorityError)
      expect(fixture.native.getNamedPipeClientProcessId).not.toHaveBeenCalled()
    }

    const aliasedProcess = api({ openProcess: vi.fn(() => 91n) })
    await expect(createWindowsPeerProcessBindings(aliasedProcess.native).openClientProcess(91n))
      .rejects.toBeInstanceOf(HostAuthorityError)

    const invalidProcess = api()
    await expect(createWindowsPeerProcessBindings(invalidProcess.native).openProcessExecutable(0n))
      .rejects.toBeInstanceOf(HostAuthorityError)

    const aliasedImage = api({ openExecutableForVerification: vi.fn(() => 101n) })
    await expect(createWindowsPeerProcessBindings(aliasedImage.native).openProcessExecutable(101n))
      .rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('fails closed even when rollback close throws', async () => {
    const processFixture = api({
      getNamedPipeClientProcessId: vi.fn().mockReturnValueOnce(42).mockReturnValueOnce(43),
      closeHandle: vi.fn(() => { throw new Error('close failed') }),
    })
    await expect(createWindowsPeerProcessBindings(processFixture.native).openClientProcess(91n))
      .rejects.toBeInstanceOf(HostAuthorityError)

    const imageFixture = api({
      finalExecutablePath: vi.fn(() => ''),
      closeHandle: vi.fn(() => { throw new Error('close failed') }),
    })
    await expect(createWindowsPeerProcessBindings(imageFixture.native).openProcessExecutable(101n))
      .rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('normalizes synchronous signature and digest failures', async () => {
    const fixture = api({
      verifyAuthenticodePublisher: vi.fn(() => { throw new Error('signature failed') }),
      digestExecutable: vi.fn(() => { throw new Error('digest failed') }),
    })
    const bindings = createWindowsPeerProcessBindings(fixture.native)
    await bindings.openProcessExecutable(101n)
    await expect(bindings.verifyAuthenticodePublisher(202n)).rejects.toBeInstanceOf(HostAuthorityError)
    await expect(bindings.digestExecutable(202n)).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('rejects non-string native image paths', async () => {
    const fixture = api({ queryProcessImagePath: vi.fn(() => 7) })
    await expect(createWindowsPeerProcessBindings(fixture.native as never).openProcessExecutable(101n))
      .rejects.toBeInstanceOf(HostAuthorityError)
  })
})
