import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HostAuthorityError } from '../src/types.ts'

const state = vi.hoisted(() => ({
  mode: 'exhaust' as 'open-error' | 'exhaust' | 'stale-race' | 'release-race',
  record: JSON.stringify({ pid: 1, uid: 7, processNonce: 'stale', ownerId: 'stale' }),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    closeSync: vi.fn(),
    fsyncSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    writeSync: vi.fn((_fd: number, value: string | Uint8Array) => {
      state.record = String(value).trim()
      return value.length
    }),
    openSync: vi.fn((_path: string, flags: number) => {
      if ((flags & actual.constants.O_CREAT) === 0) return 11
      if (state.mode === 'open-error') throw Object.assign(new Error('denied'), { code: 'EACCES' })
      if (state.mode === 'release-race') return 10
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    }),
    readFileSync: vi.fn(() => state.record),
    fstatSync: vi.fn(() => ({
      isFile: () => true,
      nlink: 1,
      uid: 7,
      mode: 0o100600,
      dev: 1,
      ino: 1,
    })),
    lstatSync: vi.fn(() => ({ dev: 1, ino: state.mode === 'exhaust' ? 1 : 2 })),
  }
})

import { acquireSingleHostLock } from '../src/single-instance.ts'

const options = {
  root: '/controlled', pid: 2, uid: 7, processNonce: 'owner-0123456789abcdef', isProcessAlive: () => false,
}

beforeEach(() => {
  state.mode = 'exhaust'
  state.record = JSON.stringify({ pid: 1, uid: 7, processNonce: 'stale', ownerId: 'stale' })
})

describe('single Host lock filesystem races', () => {
  it('preserves an unexpected exclusive-create error', async () => {
    state.mode = 'open-error'
    await expect(acquireSingleHostLock(options)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('refuses a stale record replaced between its handle and path checks', async () => {
    state.mode = 'stale-race'
    await expect(acquireSingleHostLock(options)).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('stops after two stale-lock recovery races', async () => {
    await expect(acquireSingleHostLock(options)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('refuses to release a generation swapped after its second handle read', async () => {
    state.mode = 'release-race'
    const owner = await acquireSingleHostLock(options)
    await expect(owner.release()).rejects.toMatchObject({ code: 'stale' })
  })
})
