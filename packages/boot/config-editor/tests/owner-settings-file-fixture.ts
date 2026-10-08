/** POSIX metadata for test-owned settings files; native permission suites retain real metadata. */
import { vi } from 'vitest'
import { closeSync } from 'node:fs'

const owner = vi.hoisted(() => ({
  path: undefined as string | undefined,
  uid: 0,
  mode: 0o100600,
  descriptors: new Set<number>(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    readFileSync: vi.fn(original.readFileSync),
    openSync: (...args: Parameters<typeof original.openSync>) => {
      const fd = original.openSync(...args)
      if (owner.path === args[0]) owner.descriptors.add(fd)
      return fd
    },
    fstatSync: (...args: Parameters<typeof original.fstatSync>) => {
      const value = original.fstatSync(...args)
      if (owner.descriptors.has(args[0])) Object.assign(value, { uid: owner.uid, mode: owner.mode })
      return value
    },
    closeSync: (fd: number) => {
      original.closeSync(fd)
      owner.descriptors.delete(fd)
    },
  }
})

/** Read one owned fixture with POSIX metadata, restoring the UID getter synchronously even on failure.
 * @param path Fixture file selected by the test.
 * @param read Real reader operation.
 * @param metadata UID/mode values used by the filesystem fixture.
 * @returns The real reader result.
 */
export function withOwnerSettingsFileFixture<T>(
  path: string, read: () => T, metadata: { uid?: number; mode?: number } = {},
): T {
  const getter = Object.getOwnPropertyDescriptor(process, 'getuid')
  if (owner.path !== undefined) throw new Error('Owner settings fixture is already reading')
  owner.path = path
  owner.uid = metadata.uid ?? 0
  owner.mode = metadata.mode ?? 0o100600
  Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true, writable: true })
  try { return read() }
  finally {
    if (getter === undefined) Reflect.deleteProperty(process, 'getuid')
    else Object.defineProperty(process, 'getuid', getter)
    owner.path = undefined
    const leaked = [...owner.descriptors]
    for (const fd of leaked) closeSync(fd)
    owner.descriptors.clear()
    if (leaked.length !== 0) throw new Error('Owner settings reader left a file descriptor open')
  }
}
