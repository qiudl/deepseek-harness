import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, isAbsolute } from 'node:path'
interface VaultNativeLibrary {
  func(convention: string, name: string, result: unknown, args: unknown[]): (...args: unknown[]) => unknown
}

interface VaultNativeModule {
  pointer(type: unknown): unknown
  struct(fields: Record<string, unknown>): { readonly size: number }
  struct(name: string, fields: Record<string, unknown>): { readonly size: number }
  alloc(type: unknown, count: number): unknown
  encode(target: unknown, type: unknown, value: Record<string, unknown>): void
  decode(value: unknown, offsetOrType: unknown, type?: unknown): unknown
  address(value: Buffer): bigint | number
  load(library: string): VaultNativeLibrary
}

/** Native file selected by the embedding's verified release metadata, never by environment input. */
export interface WindowsVaultNativeModulePin {
  readonly path: string
  readonly sha256: string
}

const MAX_NATIVE_BYTES = 64 * 1024 * 1024

/**
 * Load one digest-pinned Koffi addon without package wrappers or alternate-path search.
 * Create the default loader only after validation, relative to the exact pinned addon file.
 * The embedding must protect the installation path from replacement for the entire load/use
 * lifetime; digest verification alone does not establish Windows ACL or publisher authority.
 * @param pin - canonical addon path and digest from independently verified release metadata.
 * @param load - exact-file native loader owned by the embedding or test harness.
 * @returns native functions required by the private-file and process-SID adapters.
 */
export function loadPinnedWindowsVaultNativeModule(
  pin: WindowsVaultNativeModulePin | undefined,
  load?: (path: string) => unknown,
): VaultNativeModule {
  if (!pin || !isAbsolute(pin.path) || basename(pin.path) !== 'koffi.node'
    || !/^[a-f0-9]{64}$/u.test(pin.sha256)) {
    throw new Error('Windows vault native module release pin is invalid')
  }
  const metadata = lstatSync(pin.path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || realpathSync(pin.path) !== pin.path) {
    throw new Error('Windows vault native module must be a canonical singly linked file')
  }
  const fd = openSync(pin.path, 'r')
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 1 || opened.size > MAX_NATIVE_BYTES
      || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error('Windows vault native module file changed or exceeds its size limit')
    }
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error('Windows vault native module read was incomplete')
      offset += count
    }
    if (fstatSync(fd).size !== opened.size
      || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
      throw new Error('Windows vault native module digest mismatch')
    }
    const native: unknown = (load ?? createRequire(pin.path))(pin.path)
    if (!native || typeof native !== 'object'
      || ['pointer', 'struct', 'alloc', 'encode', 'decode', 'address', 'load'].some(
        key => typeof (native as Record<string, unknown>)[key] !== 'function',
      )) {
      throw new Error('Windows vault native module functions are unavailable')
    }
    return native as VaultNativeModule
  } finally {
    closeSync(fd)
  }
}
