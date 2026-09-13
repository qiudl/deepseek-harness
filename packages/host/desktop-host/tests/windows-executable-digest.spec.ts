import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { loadWindowsExecutableDigest } from '../src/windows-executable-digest.ts'
import { WindowsPeerProcessNativeError } from '../src/windows-peer-process-native.ts'

interface FakeOptions {
  readonly data?: Buffer
  readonly declaredSize?: bigint
  readonly maxReadBytes?: number
  readonly readFailure?: number
  readonly zeroProgress?: boolean
}

function fakeWorld(options: FakeOptions = {}) {
  const data = options.data ?? Buffer.from('stable executable bytes')
  let offset = 0
  let lastError = 0
  const readSizes: number[] = []
  const setPointer = vi.fn((_handle, distance, _newPosition, method) => {
    if (distance !== 0n || method !== 0) return 0
    offset = 0
    return 1
  })
  const functions: Record<string, (...args: unknown[]) => unknown> = {
    GetFileSizeEx: (_handle, output) => {
      if (!Buffer.isBuffer(output)) throw new Error('expected file size buffer')
      output.writeBigInt64LE(options.declaredSize ?? BigInt(data.length))
      return 1
    },
    SetFilePointerEx: setPointer,
    ReadFile: (_handle, output, requested, read) => {
      if (!Buffer.isBuffer(output) || !Buffer.isBuffer(read)) throw new Error('expected file read buffers')
      const bytesRequested = Number(requested)
      readSizes.push(bytesRequested)
      if (options.readFailure !== undefined) { lastError = options.readFailure; return 0 }
      if (options.zeroProgress) { read.writeUInt32LE(0); return 1 }
      const count = Math.min(bytesRequested, options.maxReadBytes ?? bytesRequested, data.length - offset)
      data.copy(output, 0, offset, offset + count)
      offset += count
      read.writeUInt32LE(count)
      return 1
    },
    GetLastError: () => lastError,
  }
  const koffi = {
    pointer: vi.fn((value: unknown) => ({ pointer: value })),
    load: vi.fn(() => ({
      func: vi.fn((_convention: string, name: string) => {
        const nativeFunction = functions[name]
        if (!nativeFunction) throw new Error(`unexpected native function: ${name}`)
        return nativeFunction
      }),
    })),
  }
  return { data, functions, koffi, readSizes, setPointer }
}

async function load(world = fakeWorld()) {
  const digest = await loadWindowsExecutableDigest({
    platform: 'win32', arch: 'x64', isMainThread: false,
    loadKoffi: async () => world.koffi,
  })
  return { digest, world }
}

describe('Windows stable executable digest', () => {
  it('refuses blocking file reads outside a Windows x64 worker', async () => {
    const loadKoffi = vi.fn()
    await expect(loadWindowsExecutableDigest({
      platform: 'win32', arch: 'x64', isMainThread: true, loadKoffi,
    })).rejects.toThrow('Windows x64 worker')
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('rewinds and streams SHA-256 from the caller-owned stable handle', async () => {
    const world = fakeWorld({
      data: Buffer.alloc(150_000, 0x5a),
      maxReadBytes: 7_919,
    })
    const { digest } = await load(world)
    expect(digest(802n)).toBe(createHash('sha256').update(world.data).digest('hex'))
    expect(world.setPointer).toHaveBeenCalledWith(802n, 0n, null, 0)
    expect(Math.max(...world.readSizes)).toBeLessThanOrEqual(64 * 1024)
    expect(world.readSizes.length).toBeGreaterThan(3)
  })

  it('rejects empty, oversized, and invalid stable handles before hashing', async () => {
    for (const declaredSize of [0n, 512n * 1024n * 1024n + 1n]) {
      const world = fakeWorld({ declaredSize })
      const { digest } = await load(world)
      expect(() => digest(802n)).toThrow(WindowsPeerProcessNativeError)
      expect(world.readSizes).toEqual([])
    }
    const { digest } = await load()
    expect(() => digest(0n)).toThrow(WindowsPeerProcessNativeError)
  })

  it('rejects successful zero-progress reads and premature EOF', async () => {
    const stalled = await load(fakeWorld({ zeroProgress: true }))
    expect(() => stalled.digest(802n)).toThrow(WindowsPeerProcessNativeError)

    const truncated = await load(fakeWorld({ data: Buffer.from('short'), declaredSize: 20n }))
    expect(() => truncated.digest(802n)).toThrow(WindowsPeerProcessNativeError)
  })

  it('retains the exact ReadFile error code', async () => {
    const { digest } = await load(fakeWorld({ readFailure: 5 }))
    const error = (() => { try { digest(802n) } catch (caught) { return caught } })()
    expect(error).toBeInstanceOf(WindowsPeerProcessNativeError)
    expect(error).toMatchObject({ api: 'ReadFile', win32Code: 5 })
  })
})
