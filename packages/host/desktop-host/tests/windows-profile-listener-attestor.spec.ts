import { describe, expect, it, vi } from 'vitest'
import {
  loadWindowsProfileListenerAttestor,
  WindowsProfileListenerNativeError,
} from '../src/windows-profile-listener-attestor.ts'

function loader(getExtendedTcpTable: (...args: unknown[]) => unknown) {
  return async () => ({
    pointer: vi.fn((value: unknown) => ({ pointer: value })),
    load: vi.fn(() => ({
      func: vi.fn((_convention: string, name: string) => name === 'GetExtendedTcpTable'
        ? getExtendedTcpTable
        : () => 0),
    })),
  })
}

describe('Windows Profile listener attestor', () => {
  it('resolves omitted platform facts from the active runtime', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64')
    try {
      await expect(loadWindowsProfileListenerAttestor({ loadKoffi: loader(vi.fn()) })).resolves.toBeTypeOf('function')
    } finally {
      platform.mockRestore()
      arch.mockRestore()
    }
  })

  it('refuses unsupported runtimes before loading Koffi', async () => {
    const loadKoffi = vi.fn()
    await expect(loadWindowsProfileListenerAttestor({
      platform: 'linux', arch: 'x64', loadKoffi,
    })).rejects.toThrow('Windows x64')
    expect(loadKoffi).not.toHaveBeenCalled()
  })

  it('accepts only a loopback listener owned by the exact child PID', async () => {
    let call = 0
    const getExtendedTcpTable = vi.fn((table: unknown, size: unknown) => {
      if (!Buffer.isBuffer(size)) throw new Error('expected TCP table size buffer')
      if (table !== null && !Buffer.isBuffer(table)) throw new Error('expected TCP table buffer or null')
      call += 1
      size.writeUInt32LE(28)
      if (table === null) return 122
      table.writeUInt32LE(1, 0)
      table.writeUInt32LE(2, 4)
      Buffer.from([127, 0, 0, 1]).copy(table, 8)
      table.writeUInt16BE(43125, 12)
      table.writeUInt32LE(842, 24)
      return 0
    })
    const koffi = {
      pointer: vi.fn((value: unknown) => ({ pointer: value })),
      load: vi.fn(() => ({
        func: vi.fn((_convention: string, name: string) => name === 'GetExtendedTcpTable'
          ? getExtendedTcpTable
          : () => 0),
      })),
    }
    const attest = await loadWindowsProfileListenerAttestor({
      platform: 'win32', arch: 'x64', loadKoffi: async () => koffi,
    })
    await expect(attest(842, 'http://127.0.0.1:43125')).resolves.toBeUndefined()
    expect(call).toBe(2)
    expect(getExtendedTcpTable.mock.calls[1]?.slice(2)).toEqual([0, 2, 3, 0])
    await expect(attest(843, 'http://127.0.0.1:43125')).rejects.toThrow()
    await expect(attest(842, 'http://0.0.0.0:43125')).rejects.toThrow()
  })

  it('rejects malformed PIDs and origins before querying the table', async () => {
    const getExtendedTcpTable = vi.fn()
    const attest = await loadWindowsProfileListenerAttestor({
      platform: 'win32', arch: 'x64', loadKoffi: loader(getExtendedTcpTable),
    })
    for (const pid of [0, -1, Number.NaN]) {
      await expect(attest(pid, 'http://127.0.0.1:43125')).rejects.toThrow()
    }
    for (const origin of [
      'not a URL', 'https://127.0.0.1:43125', 'http://localhost:43125',
      'http://user@127.0.0.1:43125', 'http://127.0.0.1', 'http://127.0.0.1:43125/',
    ]) {
      await expect(attest(842, origin)).rejects.toThrow()
    }
    expect(getExtendedTcpTable).not.toHaveBeenCalled()
  })

  it('preserves sizing and loading Win32 failures', async () => {
    for (const code of [5, 0]) {
      const getExtendedTcpTable = vi.fn(() => code)
      const attest = await loadWindowsProfileListenerAttestor({
        platform: 'win32', arch: 'x64', loadKoffi: loader(getExtendedTcpTable),
      })
      await expect(attest(842, 'http://127.0.0.1:43125'))
        .rejects.toEqual(expect.objectContaining<Partial<WindowsProfileListenerNativeError>>({ win32Code: code }))
    }

    const getExtendedTcpTable = vi.fn((table: unknown, size: unknown) => {
      const sizeBuffer = size as Buffer
      sizeBuffer.writeUInt32LE(28)
      return table === null ? 122 : 5
    })
    const attest = await loadWindowsProfileListenerAttestor({
      platform: 'win32', arch: 'x64', loadKoffi: loader(getExtendedTcpTable),
    })
    await expect(attest(842, 'http://127.0.0.1:43125'))
      .rejects.toEqual(expect.objectContaining<Partial<WindowsProfileListenerNativeError>>({ win32Code: 5 }))
  })

  it('rejects unsafe size, returned-byte, and row-count facts', async () => {
    const cases = [
      { sizedBytes: 3, returnedBytes: 3, rows: 0 },
      { sizedBytes: 16 * 1024 * 1024 + 1, returnedBytes: 4, rows: 0 },
      { sizedBytes: 28, returnedBytes: 3, rows: 0 },
      { sizedBytes: 28, returnedBytes: 29, rows: 0 },
      { sizedBytes: 28, returnedBytes: 28, rows: 2 },
    ]
    for (const item of cases) {
      const getExtendedTcpTable = vi.fn((table: unknown, size: unknown) => {
        const sizeBuffer = size as Buffer
        sizeBuffer.writeUInt32LE(table === null ? item.sizedBytes : item.returnedBytes)
        if (Buffer.isBuffer(table) && table.length >= 4) table.writeUInt32LE(item.rows, 0)
        return table === null ? 122 : 0
      })
      const attest = await loadWindowsProfileListenerAttestor({
        platform: 'win32', arch: 'x64', loadKoffi: loader(getExtendedTcpTable),
      })
      await expect(attest(842, 'http://127.0.0.1:43125')).rejects.toBeInstanceOf(WindowsProfileListenerNativeError)
    }
  })

  it('requires one matching listening loopback row and no duplicate owner', async () => {
    for (const mutation of ['state', 'address', 'port', 'duplicate'] as const) {
      const rows = mutation === 'duplicate' ? 2 : 1
      const bytes = 4 + rows * 24
      const getExtendedTcpTable = vi.fn((table: unknown, size: unknown) => {
        const sizeBuffer = size as Buffer
        sizeBuffer.writeUInt32LE(bytes)
        if (table === null) return 122
        const buffer = table as Buffer
        buffer.writeUInt32LE(rows, 0)
        for (let index = 0; index < rows; index += 1) {
          const offset = 4 + index * 24
          buffer.writeUInt32LE(mutation === 'state' ? 5 : 2, offset)
          Buffer.from(mutation === 'address' ? [0, 0, 0, 0] : [127, 0, 0, 1]).copy(buffer, offset + 4)
          buffer.writeUInt16BE(mutation === 'port' ? 43126 : 43125, offset + 8)
          buffer.writeUInt32LE(842, offset + 20)
        }
        return 0
      })
      const attest = await loadWindowsProfileListenerAttestor({
        platform: 'win32', arch: 'x64', loadKoffi: loader(getExtendedTcpTable),
      })
      await expect(attest(842, 'http://127.0.0.1:43125')).rejects.toThrow()
    }
  })
})
