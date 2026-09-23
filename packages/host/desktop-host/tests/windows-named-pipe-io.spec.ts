import { describe, expect, it, vi } from 'vitest'
import {
  WINDOWS_NAMED_PIPE_MAX_FRAME_BYTES,
  createWindowsNamedPipeIoBindings,
  loadWindowsNamedPipeIoBindings,
} from '../src/windows-named-pipe-io.ts'
import { WindowsNamedPipeNativeError } from '../src/windows-named-pipe-native.ts'

function api(overrides: Record<string, unknown> = {}) {
  return {
    readFile: vi.fn((_handle: bigint, buffer: Buffer) => {
      Buffer.from('reply').copy(buffer)
      return { result: 1, byteCount: 5, win32Code: 0 }
    }),
    writeFile: vi.fn((_handle: bigint, buffer: Buffer) => ({
      result: 1,
      byteCount: buffer.byteLength,
      win32Code: 0,
    })),
    ...overrides,
  }
}

describe('Windows named-pipe checked byte I/O', () => {
  it('returns only initialized bytes and maps peer disconnect codes to EOF', async () => {
    const native = api()
    const bindings = createWindowsNamedPipeIoBindings(native)
    await expect(bindings.read(91n, 32)).resolves.toEqual(Buffer.from('reply'))
    expect(native.readFile).toHaveBeenCalledWith(91n, expect.any(Buffer))

    for (const win32Code of [109, 232, 233]) {
      const disconnected = createWindowsNamedPipeIoBindings(api({
        readFile: vi.fn(() => ({ result: 0, byteCount: 0, win32Code })),
      }))
      await expect(disconnected.read(91n, 32)).resolves.toBeNull()
    }
  })

  it('rejects invalid handles, read bounds, and impossible native byte counts', async () => {
    const bindings = createWindowsNamedPipeIoBindings(api())
    await expect(bindings.read(0n, 32)).rejects.toThrow('invalid Windows named-pipe handle')
    await expect(bindings.read('91' as never, 32)).rejects.toThrow('invalid Windows named-pipe handle')
    await expect(bindings.read(91n, 0)).rejects.toThrow('invalid Windows named-pipe read size')
    await expect(bindings.read(91n, WINDOWS_NAMED_PIPE_MAX_FRAME_BYTES + 1))
      .rejects.toThrow('invalid Windows named-pipe read size')

    for (const byteCount of [-1, 33, Number.NaN]) {
      const malformed = createWindowsNamedPipeIoBindings(api({
        readFile: vi.fn(() => ({ result: 1, byteCount, win32Code: 0 })),
      }))
      await expect(malformed.read(91n, 32)).rejects.toBeInstanceOf(WindowsNamedPipeNativeError)
    }

    const hostile = createWindowsNamedPipeIoBindings(api({
      readFile: vi.fn(() => { throw 'native bridge failure' }),
    }))
    await expect(hostile.read(91n, 32)).rejects.toThrow('Unknown Win32 named-pipe I/O failure')
  })

  it('finishes partial writes without silently truncating a protocol frame', async () => {
    const chunks: string[] = []
    const native = api({
      writeFile: vi.fn((_handle: bigint, buffer: Buffer) => {
        const byteCount = Math.min(2, buffer.byteLength)
        chunks.push(buffer.subarray(0, byteCount).toString('utf8'))
        return { result: 1, byteCount, win32Code: 0 }
      }),
    })
    await expect(createWindowsNamedPipeIoBindings(native).writeFrame(91n, Buffer.from('abcdef')))
      .resolves.toBeUndefined()
    expect(chunks).toEqual(['ab', 'cd', 'ef'])
  })

  it('rejects empty, oversized, zero-progress, and impossible writes', async () => {
    const bindings = createWindowsNamedPipeIoBindings(api())
    await expect(bindings.writeFrame(0n, Buffer.from('frame\n')))
      .rejects.toThrow('invalid Windows named-pipe handle')
    await expect(bindings.writeFrame(91n, Buffer.alloc(0)))
      .rejects.toThrow('invalid Windows named-pipe frame size')
    await expect(bindings.writeFrame(91n, Buffer.alloc(WINDOWS_NAMED_PIPE_MAX_FRAME_BYTES + 1)))
      .rejects.toThrow('invalid Windows named-pipe frame size')

    for (const byteCount of [0, 3, Number.NaN]) {
      const malformed = createWindowsNamedPipeIoBindings(api({
        writeFile: vi.fn(() => ({ result: 1, byteCount, win32Code: 0 })),
      }))
      await expect(malformed.writeFrame(91n, Buffer.from('ab')))
        .rejects.toBeInstanceOf(WindowsNamedPipeNativeError)
    }
  })

  it('preserves exact ReadFile and WriteFile failure codes', async () => {
    const readFailure = createWindowsNamedPipeIoBindings(api({
      readFile: vi.fn(() => ({ result: 0, byteCount: 0, win32Code: 5 })),
    }))
    await expect(readFailure.read(91n, 32)).rejects.toMatchObject({ api: 'ReadFile', win32Code: 5 })

    const writeFailure = createWindowsNamedPipeIoBindings(api({
      writeFile: vi.fn(() => ({ result: 0, byteCount: 0, win32Code: 995 })),
    }))
    await expect(writeFailure.writeFrame(91n, Buffer.from('frame\n')))
      .rejects.toMatchObject({ api: 'WriteFile', win32Code: 995 })
  })

  it('loads only in a Windows x64 worker and captures GetLastError inside each raw call', async () => {
    const loadKoffi = vi.fn()
    await expect(loadWindowsNamedPipeIoBindings()).rejects.toThrow('Windows x64 worker')
    await expect(loadWindowsNamedPipeIoBindings({
      platform: 'win32', arch: 'x64', isMainThread: true, loadKoffi,
    })).rejects.toThrow('Windows x64 worker')
    expect(loadKoffi).not.toHaveBeenCalled()

    let byteCount = 0
    let lastError = 0
    const read = vi.fn((_handle: unknown, buffer: unknown) => {
      if (!Buffer.isBuffer(buffer)) throw new Error('expected ReadFile buffer')
      Buffer.from('ok').copy(buffer)
      byteCount = 2
      return 1
    })
    const write = vi.fn((_handle: unknown, buffer: unknown) => {
      if (!Buffer.isBuffer(buffer)) throw new Error('expected WriteFile buffer')
      byteCount = buffer.byteLength
      return 1
    })
    const getLastError = vi.fn(() => lastError)
    const functions: Record<string, (...args: unknown[]) => unknown> = {
      ReadFile: read,
      WriteFile: write,
      GetLastError: getLastError,
    }
    const koffi = {
      pointer: vi.fn((value: unknown) => ({ pointer: value })),
      alloc: vi.fn(() => 77n),
      decode: vi.fn(() => byteCount),
      load: vi.fn(() => ({
        func: vi.fn((_convention: string, name: string) => {
          const nativeFunction = functions[name]
          if (!nativeFunction) throw new Error(`unexpected native function: ${name}`)
          return nativeFunction
        }),
      })),
    }
    const bindings = await loadWindowsNamedPipeIoBindings({
      platform: 'win32', arch: 'x64', isMainThread: false, loadKoffi: async () => koffi,
    })
    await expect(bindings.read(91n, 32)).resolves.toEqual(Buffer.from('ok'))
    await expect(bindings.writeFrame(91n, Buffer.from('request\n'))).resolves.toBeUndefined()
    expect(read).toHaveBeenCalledWith(91n, expect.any(Buffer), 32, 77n, null)
    expect(write).toHaveBeenCalledWith(91n, expect.any(Buffer), 8, 77n, null)
    expect(getLastError).not.toHaveBeenCalled()

    lastError = 5
    read.mockReturnValueOnce(0)
    byteCount = 0
    await expect(bindings.read(91n, 32)).rejects.toMatchObject({ api: 'ReadFile', win32Code: 5 })
    expect(getLastError).toHaveBeenCalledOnce()
  })
})
