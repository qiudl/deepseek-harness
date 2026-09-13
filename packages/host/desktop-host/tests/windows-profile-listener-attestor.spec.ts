import { describe, expect, it, vi } from 'vitest'
import { loadWindowsProfileListenerAttestor } from '../src/windows-profile-listener-attestor.ts'

describe('Windows Profile listener attestor', () => {
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
})
