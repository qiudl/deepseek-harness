import { describe, expect, it, vi } from 'vitest'
import {
  WindowsPeerProcessNativeError,
  loadWindowsPeerProcessNativeApi,
} from '../src/windows-peer-process-native.ts'

const executablePath = String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`
const finalExecutablePath = String.raw`\\?\C:\Program Files\Slark\slark-daemon-windows-x64.exe`
const userSid = 'S-1-5-21-1000-2000-3000-1001'

interface FakeWorldOptions {
  readonly failures?: Readonly<Record<string, number>>
  readonly compareResult?: number
  readonly tokenBytes?: number
  readonly returnedTokenBytes?: number
  readonly sidText?: unknown
}

function fakeWorld(options: FakeWorldOptions = {}) {
  const calls: Array<{ readonly name: string; readonly args: readonly unknown[] }> = []
  const closed: bigint[] = []
  const freed: bigint[] = []
  let lastError = 0
  let nextToken = 700n
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    GetNamedPipeClientProcessId: (_pipe, pid) => succeed('GetNamedPipeClientProcessId', () => {
      if (!Buffer.isBuffer(pid)) throw new Error('expected client PID buffer')
      pid.writeUInt32LE(42)
      return 1
    }),
    GetNamedPipeServerProcessId: (_pipe, pid) => succeed('GetNamedPipeServerProcessId', () => {
      if (!Buffer.isBuffer(pid)) throw new Error('expected server PID buffer')
      pid.writeUInt32LE(84)
      return 1
    }),
    OpenProcess: (_access, _inherit, pid) => succeed('OpenProcess', () => BigInt(Number(pid) + 100)),
    OpenProcessToken: (_process, _access, token) => succeed('OpenProcessToken', () => {
      if (!Buffer.isBuffer(token)) throw new Error('expected token buffer')
      token.writeBigUInt64LE(nextToken++)
      return 1
    }),
    GetTokenInformation: (_token, _class, info, length, needed) => {
      if (!Buffer.isBuffer(needed)) throw new Error('expected token size buffer')
      if (info !== null && !Buffer.isBuffer(info)) throw new Error('expected token information buffer or null')
      calls.push({ name: 'GetTokenInformation', args: [_token, _class, info, length, needed] })
      const failure = options.failures?.GetTokenInformation
      if (failure !== undefined) { lastError = failure; return 0 }
      needed.writeUInt32LE(options.tokenBytes ?? 32)
      if (info === null) { lastError = 122; return 0 }
      needed.writeUInt32LE(options.returnedTokenBytes ?? options.tokenBytes ?? 32)
      info.writeBigUInt64LE(900n)
      return 1
    },
    ConvertSidToStringSidW: (_sid, output) => succeed('ConvertSidToStringSidW', () => {
      if (!Buffer.isBuffer(output)) throw new Error('expected SID output buffer')
      output.writeBigUInt64LE(901n)
      return 1
    }),
    LocalFree: (pointer) => {
      calls.push({ name: 'LocalFree', args: [pointer] })
      freed.push(pointer as bigint)
      return 0n
    },
    QueryFullProcessImageNameW: (_process, _flags, output, length) =>
      succeed('QueryFullProcessImageNameW', () => {
        if (!Buffer.isBuffer(output) || !Buffer.isBuffer(length)) throw new Error('expected image path buffers')
        const encoded = Buffer.from(executablePath, 'utf16le')
        encoded.copy(output)
        length.writeUInt32LE(executablePath.length)
        return 1
      }),
    CreateFileW: () => succeed('CreateFileW', () => 802n),
    GetFinalPathNameByHandleW: (_handle, output) => succeed('GetFinalPathNameByHandleW', () => {
      if (!Buffer.isBuffer(output)) throw new Error('expected final path buffer')
      Buffer.from(finalExecutablePath, 'utf16le').copy(output)
      return finalExecutablePath.length
    }),
    CompareStringOrdinal: () => succeed('CompareStringOrdinal', () => options.compareResult ?? 2),
    CloseHandle: handle => succeed('CloseHandle', () => {
      closed.push(handle as bigint)
      return 1
    }),
    GetLastError: () => lastError,
  }

  function succeed(name: string, result: () => unknown): unknown {
    const args = currentArgs
    calls.push({ name, args })
    const failure = options.failures?.[name]
    if (failure !== undefined) {
      lastError = failure
      return name === 'OpenProcess' || name === 'CreateFileW' ? 0n : 0
    }
    return result()
  }

  let currentArgs: readonly unknown[] = []
  const wrapped = Object.fromEntries(Object.entries(functions).map(([name, fn]) => [name, (...args: unknown[]) => {
    currentArgs = args
    return fn(...args)
  }]))
  const koffi = {
    pointer: vi.fn((value: unknown) => ({ pointer: value })),
    load: vi.fn((_library: string) => ({
      func: vi.fn((_convention: string, name: string) => {
        const nativeFunction = wrapped[name]
        if (!nativeFunction) throw new Error(`unexpected native function: ${name}`)
        return nativeFunction
      }),
    })),
    decode: vi.fn((value: unknown, offsetOrType: unknown, type?: unknown) => {
      const decodedType = type ?? offsetOrType
      const offset = type === undefined ? 0 : Number(offsetOrType)
      if (decodedType === 'str16') return options.sidText ?? userSid
      if (!Buffer.isBuffer(value)) throw new Error('expected pointer buffer')
      return value.readBigUInt64LE(offset)
    }),
  }
  return { calls, closed, freed, koffi, functions: wrapped }
}

const trust = {
  verifyAuthenticodePublisher: vi.fn(() => 'A'.repeat(64)),
  digestExecutable: vi.fn(() => 'a'.repeat(64)),
}

async function load(world = fakeWorld()) {
  const api = await loadWindowsPeerProcessNativeApi(trust, {
    platform: 'win32', arch: 'x64', isMainThread: false,
    loadKoffi: async () => world.koffi,
  })
  return { api, world }
}

describe('Windows peer-process Koffi ABI', () => {
  it('refuses native process inspection outside a Windows x64 worker', async () => {
    const loadKoffi = vi.fn()
    for (const runtime of [
      { platform: 'darwin', arch: 'arm64', isMainThread: false },
      { platform: 'win32', arch: 'x64', isMainThread: true },
    ]) {
      await expect(loadWindowsPeerProcessNativeApi(trust, { ...runtime, loadKoffi }))
        .rejects.toThrow('Windows x64 worker')
    }
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('binds the pipe PID and opens only query-limited non-inheritable process handles', async () => {
    const { api, world } = await load()
    expect(api.getNamedPipeClientProcessId(91n)).toBe(42)
    expect(api.getNamedPipeServerProcessId(91n)).toBe(84)
    expect(api.openProcess(42)).toBe(142n)
    expect(world.calls.find(call => call.name === 'OpenProcess')?.args).toEqual([0x1000, 0, 42])
  })

  it('reads both current and peer token owners and releases every temporary native resource', async () => {
    const { api, world } = await load()
    expect(api.currentUserSid()).toBe(userSid)
    expect(api.processOwnerSid(142n)).toBe(userSid)
    expect(world.closed).toEqual([700n, BigInt(process.pid + 100), 701n])
    expect(world.freed).toEqual([901n, 901n])
    const tokenReads = world.calls.filter(call => call.name === 'GetTokenInformation')
    expect(tokenReads).toHaveLength(4)
    expect(tokenReads[0]?.args.slice(1, 4)).toEqual([1, null, 0])
    expect(tokenReads[1]?.args[3]).toBe(32)
  })

  it('queries bounded image paths, locks the executable against replacement, and uses ordinal comparison', async () => {
    const { api, world } = await load()
    expect(api.queryProcessImagePath(142n)).toBe(executablePath)
    expect(api.openExecutableForVerification(executablePath)).toBe(802n)
    expect(api.finalExecutablePath(802n)).toBe(finalExecutablePath)
    expect(api.equalWindowsPath(executablePath, executablePath.toUpperCase())).toBe(true)
    expect(world.calls.find(call => call.name === 'CreateFileW')?.args).toEqual([
      executablePath, 0x80000000, 0x1, null, 3, 0x80, null,
    ])
    expect(world.calls.find(call => call.name === 'CompareStringOrdinal')?.args).toEqual([
      executablePath, -1, executablePath.toUpperCase(), -1, 1,
    ])
  })

  it('keeps signature and digest operations on the already-open stable image handle', async () => {
    const { api } = await load()
    expect(api.verifyAuthenticodePublisher(802n, executablePath)).toBe('A'.repeat(64))
    expect(api.digestExecutable(802n)).toBe('a'.repeat(64))
    expect(trust.verifyAuthenticodePublisher).toHaveBeenCalledWith(802n, executablePath)
    expect(trust.digestExecutable).toHaveBeenCalledWith(802n)
  })

  it('captures the exact Win32 error before cleanup and fails closed', async () => {
    const { api, world } = await load(fakeWorld({ failures: { GetTokenInformation: 5 } }))
    const error = (() => { try { api.processOwnerSid(142n) } catch (caught) { return caught } })()
    expect(error).toBeInstanceOf(WindowsPeerProcessNativeError)
    expect(error).toMatchObject({ api: 'GetTokenInformation', win32Code: 5 })
    expect(world.closed).toEqual([700n])
  })

  it('rejects an oversized token record and a failed Windows string comparison', async () => {
    const oversized = fakeWorld({ tokenBytes: 65_537 })
    const { api } = await load(oversized)
    expect(() => api.processOwnerSid(142n)).toThrow(WindowsPeerProcessNativeError)
    expect(oversized.calls.filter(call => call.name === 'GetTokenInformation')).toHaveLength(1)
    expect(oversized.closed).toEqual([700n])

    const unequal = await load(fakeWorld({ compareResult: 3 }))
    expect(unequal.api.equalWindowsPath(executablePath, executablePath)).toBe(false)
  })

  it('releases the converted SID string and token when string decoding is malformed', async () => {
    const world = fakeWorld({ sidText: 42 })
    const { api } = await load(world)
    expect(() => api.processOwnerSid(142n)).toThrow(WindowsPeerProcessNativeError)
    expect(world.freed).toEqual([901n])
    expect(world.closed).toEqual([700n])
  })

  it('rejects a token record that grows between the size query and the checked read', async () => {
    const world = fakeWorld({ tokenBytes: 32, returnedTokenBytes: 48 })
    const { api } = await load(world)
    expect(() => api.processOwnerSid(142n)).toThrow(WindowsPeerProcessNativeError)
    expect(world.calls.filter(call => call.name === 'ConvertSidToStringSidW')).toEqual([])
    expect(world.closed).toEqual([700n])
  })
})
