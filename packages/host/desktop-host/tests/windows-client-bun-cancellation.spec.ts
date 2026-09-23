import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import { loadWindowsHostClientWorkerCancellation } from '../src/windows-client-bun-cancellation.ts'

it('loads the Main-thread Windows cancellation ABI with HANDLE-safe u64 arguments', async () => {
  const calls: Array<{ name: string; handle?: bigint }> = []
  let lastError = 1168
  const cancellation = await loadWindowsHostClientWorkerCancellation({
    platform: 'win32',
    arch: 'x64',
    loadFfi: async () => ({
      dlopen(path, definitions) {
        assert.equal(path, 'kernel32.dll')
        assert.deepEqual(definitions, {
          CancelSynchronousIo: { args: ['u64'], returns: 'i32' },
          CloseHandle: { args: ['u64'], returns: 'i32' },
          GetLastError: { args: [], returns: 'u32' },
        })
        return {
          symbols: {
            CancelSynchronousIo(handle: bigint) {
              calls.push({ name: 'cancel', handle })
              return lastError === 0 ? 1 : 0
            },
            CloseHandle(handle: bigint) {
              calls.push({ name: 'close', handle })
              return 1
            },
            GetLastError() { return lastError },
          },
        }
      },
    }),
  })
  assert.equal(cancellation.cancel(0x1_0000_0001n), 'no_pending_io')
  lastError = 0
  assert.equal(cancellation.cancel(0x1_0000_0001n), 'cancelled')
  cancellation.close(0x1_0000_0001n)
  assert.deepEqual(calls, [
    { name: 'cancel', handle: 0x1_0000_0001n },
    { name: 'cancel', handle: 0x1_0000_0001n },
    { name: 'close', handle: 0x1_0000_0001n },
  ])
  assert.throws(() => cancellation.cancel(0n), /invalid thread handle/u)
  assert.throws(() => cancellation.cancel('1' as never), /invalid thread handle/u)
  assert.throws(() => cancellation.openCurrentThreadHandle(), /belongs to the Worker/u)
  assert.throws(() =>{  cancellation.abandonUnhandedThreadHandle(1n) }, /belongs to the Worker/u)
  lastError = 5
  assert.throws(() => cancellation.cancel(1n), /Win32 error 5/u)
  assert.throws(() =>{  cancellation.close(0xffff_ffff_ffff_ffffn) }, /invalid thread handle/u)
})

it('rejects unsupported runtime facts before loading native code', async () => {
  let loaded = false
  await assert.rejects(loadWindowsHostClientWorkerCancellation({
    platform: 'darwin',
    arch: 'x64',
    loadFfi: async () => { loaded = true; throw new Error('must not load') },
  }), /requires Windows x64/u)
  assert.equal(loaded, false)

  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
  await assert.rejects(loadWindowsHostClientWorkerCancellation({
    loadFfi: async () => { loaded = true; throw new Error('must not load') },
  }), /requires Windows x64/u)
  platform.mockRestore()
  arch.mockRestore()
  assert.equal(loaded, false)
})

it('preserves the first native error and reports handle release failures', async () => {
  let reads = 0
  const cancellation = await loadWindowsHostClientWorkerCancellation({
    platform: 'win32',
    arch: 'x64',
    loadFfi: async () => ({ dlopen: () => ({ symbols: {
      CancelSynchronousIo: () => 0,
      CloseHandle: () => 0,
      GetLastError: () => ++reads === 1 ? 5 : 6,
    } }) }),
  })
  assert.throws(() => cancellation.cancel(1n), /Win32 error 5/u)
  assert.equal(reads, 1)
  assert.throws(() =>{  cancellation.close(1n) }, /Win32 error 6/u)
})
