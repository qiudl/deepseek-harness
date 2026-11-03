import { chmodSync, mkdtempSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { MemoryWorkerListener } from '../src/memory-worker-listener.ts'

function parent(): string {
  const root = mkdtempSync(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'dsh-hy-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

it.skipIf(process.platform === 'win32')('publishes a socket only after its private ACL preparation', async () => {
  const root = parent()
  let prepared = false
  let accepted = false
  const listener = new MemoryWorkerListener(root, async (socket) => {
    accepted = true
    socket.destroy()
  }, async (path) => {
    expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o700)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    prepared = true
  })
  onTestFinished(async () => { await listener.close() })
  const path = await listener.start()
  expect(prepared).toBe(true)
  expect(lstatSync(dirname(path)).mode & 0o777).toBe(0o711)
  const client = createConnection(path)
  client.on('error', () => {})
  await once(client, 'connect')
  client.destroy()
  expect(accepted).toBe(true)
  await listener.close()
  expect(() => lstatSync(dirname(path))).toThrow()
})

it.skipIf(process.platform === 'win32')('removes an unexposed socket when ACL installation fails', async () => {
  const root = parent()
  const listener = new MemoryWorkerListener(root, async (socket) => { socket.destroy() }, async () => {
    throw Error('synthetic ACL failure')
  })
  await expect(listener.start()).rejects.toThrow('synthetic ACL failure')
  expect(readdirSync(root)).toEqual([])
  await listener.close()
})

it.skipIf(process.platform === 'win32')('rejects a writable parent before creating a socket', async () => {
  const root = parent()
  chmodSync(root, 0o777)
  const listener = new MemoryWorkerListener(root, async (socket) => { socket.destroy() }, async () => {})
  await expect(listener.start()).rejects.toThrow()
  expect(readdirSync(root)).toEqual([])
})
