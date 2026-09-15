import type { ProfileListenerAttestor } from './dsh-web-profile-worker.ts'
import { HostAuthorityError } from './types.ts'
import { loadWindowsKoffi, type WindowsKoffiModule } from './windows-koffi.ts'

const ERROR_SUCCESS = 0
const ERROR_INSUFFICIENT_BUFFER = 122
const AF_INET = 2
const TCP_TABLE_OWNER_PID_LISTENER = 3
const MIB_TCP_STATE_LISTEN = 2
const TABLE_HEADER_BYTES = 4
const TCP_ROW_BYTES = 24
const MAX_TCP_TABLE_BYTES = 16 * 1024 * 1024

/** Injectable runtime facts for the Windows TCP owner-table loader. */
export interface WindowsProfileListenerKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly loadKoffi?: () => Promise<WindowsKoffiModule>
}

/** Exact IP Helper error retained in local diagnostics. */
export class WindowsProfileListenerNativeError extends Error {
  constructor(readonly win32Code: number) {
    super(`GetExtendedTcpTable failed with Win32 code ${win32Code}`)
    this.name = 'WindowsProfileListenerNativeError'
  }
}

function listenerPort(origin: string): number {
  let parsed: URL
  try { parsed = new URL(origin) } catch { throw new HostAuthorityError('invalid_input') }
  if (parsed.origin !== origin || parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
    || parsed.username || parsed.password || parsed.port === '') throw new HostAuthorityError('invalid_input')
  const port = Number(parsed.port)
  /* v8 ignore next -- WHATWG URL accepts only normalized TCP ports in this numeric range. */
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new HostAuthorityError('invalid_input')
  return port
}

/** Load exact child-PID ownership attestation for one IPv4 loopback listener. */
export async function loadWindowsProfileListenerAttestor(
  options: WindowsProfileListenerKoffiOptions = {},
): Promise<ProfileListenerAttestor> {
  if ((options.platform ?? process.platform) !== 'win32' || (options.arch ?? process.arch) !== 'x64') {
    throw new Error('Windows Profile listener attestation requires Windows x64')
  }
  const koffi = await loadWindowsKoffi(options.loadKoffi)
  const pointer = koffi.pointer('void')
  const iphlpapi = koffi.load('iphlpapi.dll')
  const getExtendedTcpTable = iphlpapi.func('__stdcall', 'GetExtendedTcpTable', 'uint32', [
    pointer, koffi.pointer('uint32'), 'int', 'uint32', 'int', 'uint32',
  ])

  return async (pid, origin) => {
    await Promise.resolve()
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new HostAuthorityError('invalid_input')
    const port = listenerPort(origin)
    const size = Buffer.alloc(4)
    const sized = Number(getExtendedTcpTable(
      null, size, 0, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0,
    ))
    if (sized !== ERROR_INSUFFICIENT_BUFFER) throw new WindowsProfileListenerNativeError(sized)
    const bytes = size.readUInt32LE(0)
    if (bytes < TABLE_HEADER_BYTES || bytes > MAX_TCP_TABLE_BYTES) {
      throw new WindowsProfileListenerNativeError(ERROR_INSUFFICIENT_BUFFER)
    }
    const table = Buffer.alloc(bytes)
    const loaded = Number(getExtendedTcpTable(
      table, size, 0, AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0,
    ))
    if (loaded !== ERROR_SUCCESS) throw new WindowsProfileListenerNativeError(loaded)
    const returnedBytes = size.readUInt32LE(0)
    if (returnedBytes < TABLE_HEADER_BYTES || returnedBytes > table.length) {
      throw new WindowsProfileListenerNativeError(ERROR_INSUFFICIENT_BUFFER)
    }
    const rows = table.readUInt32LE(0)
    if (rows > Math.floor((returnedBytes - TABLE_HEADER_BYTES) / TCP_ROW_BYTES)) {
      throw new WindowsProfileListenerNativeError(ERROR_INSUFFICIENT_BUFFER)
    }
    const owners: number[] = []
    for (let index = 0; index < rows; index += 1) {
      const offset = TABLE_HEADER_BYTES + index * TCP_ROW_BYTES
      if (table.readUInt32LE(offset) === MIB_TCP_STATE_LISTEN
        && table.subarray(offset + 4, offset + 8).equals(Buffer.from([127, 0, 0, 1]))
        && table.readUInt16BE(offset + 8) === port) {
        owners.push(table.readUInt32LE(offset + 20))
      }
    }
    if (owners.length !== 1 || owners[0] !== pid) throw new HostAuthorityError('unavailable')
  }
}
