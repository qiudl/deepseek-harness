import type * as Fs from 'node:fs'
import { vi } from 'vitest'

type FixtureFiles = Omit<typeof Fs, 'fstatSync' | 'statSync'> & {
  fstatSync(fd: number): Fs.Stats
  statSync(path: Fs.PathLike): Fs.Stats
}

/** Simulate POSIX metadata on Windows while retaining real file bytes and Loader composition.
 * @param fs Original filesystem bindings; POSIX hosts retain every native check.
 * @returns Test-only bindings for the legacy POSIX settings owner.
 */
export function posixFileFixture(fs: typeof Fs): FixtureFiles {
  if (process.platform !== 'win32') return fs
  const descriptors = new Map<number, string>(), modes = new Map<string, number>()
  const fixtureUid = process.getuid?.() ?? 0
  const uid = () => fixtureUid
  vi.stubGlobal('process', new Proxy(process, {
    get(target, key, receiver): unknown { return key === 'getuid' ? uid : Reflect.get(target, key, receiver) },
  }))
  const metadata = (stat: Fs.Stats, path: string) => new Proxy(stat, {
    get(target, key, receiver): unknown {
      if (key === 'uid') return uid()
      if (key === 'mode') return (target.mode & ~0o777) | (modes.get(path) ?? 0o600)
      return Reflect.get(target, key, receiver)
    },
  })
  return {
    ...fs,
    openSync(path: Fs.PathLike, flags: Fs.OpenMode, mode?: Fs.Mode | null) {
      if (flags === fs.constants.O_RDONLY && fs.lstatSync(path).isSymbolicLink()) throw Error('POSIX no-follow fixture')
      const fd = fs.openSync(path, flags, mode)
      descriptors.set(fd, String(path))
      return fd
    },
    closeSync(fd: number) { descriptors.delete(fd); fs.closeSync(fd) },
    fstatSync(fd: number) { return metadata(fs.fstatSync(fd), descriptors.get(fd) ?? '') },
    statSync(path: Fs.PathLike) { return metadata(fs.statSync(path), String(path)) },
    chmodSync(path: Fs.PathLike, mode: Fs.Mode) {
      modes.set(String(path), typeof mode === 'number' ? mode : Number.parseInt(mode, 8))
      fs.chmodSync(path, mode)
    },
  }
}
