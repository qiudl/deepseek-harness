import { isMainThread } from 'node:worker_threads'
import {
  WindowsAuthenticodeError,
  createWindowsAuthenticodeVerifier,
} from './windows-authenticode.ts'
import type { WindowsAuthenticodeNativeApi } from './windows-authenticode.ts'

const WTD_UI_NONE = 2
const WTD_REVOKE_NONE = 0
const WTD_CHOICE_FILE = 1
const WTD_STATEACTION_VERIFY = 1
const WTD_STATEACTION_CLOSE = 2
const WTD_REVOCATION_CHECK_NONE = 0x10
const WTD_CACHE_ONLY_URL_RETRIEVAL = 0x1000
const CERT_SHA256_HASH_PROP_ID = 107
const ERROR_INVALID_DATA = 13
const SHA256_BYTES = 32
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn

interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary {
  func(convention: string, name: string, result: unknown, args: unknown[]): KoffiFunction
}
interface KoffiStruct { readonly size: number }
interface KoffiModule {
  pointer(type: unknown): unknown
  struct(name: string, fields: Record<string, unknown>): KoffiStruct
  alloc(type: unknown, count: number): unknown
  encode(target: unknown, type: unknown, value: Record<string, unknown>): void
  decode(value: unknown, offsetOrType: unknown, type?: unknown): unknown
  address(value: Buffer): bigint | number
  load(library: string): KoffiLibrary
}

/** Runtime facts and injectable seam for the worker-local WinTrust loader. */
export interface WindowsAuthenticodeKoffiOptions {
  readonly platform?: string
  readonly arch?: string
  readonly isMainThread?: boolean
  readonly loadKoffi?: () => Promise<KoffiModule>
  /** Forwarded to {@link createWindowsAuthenticodeVerifier} for a pinned, unchained signer. */
  readonly acceptUntrustedRoot?: boolean
}

interface VerificationContext {
  readonly executableHandle: bigint
  readonly canonicalPath: string
  readonly pathStorage: Buffer
  readonly fileInfo: unknown
  readonly trustData: unknown
}

function actionGenericVerifyV2(): Buffer {
  const guid = Buffer.alloc(16)
  guid.writeUInt32LE(0x00AAC56B, 0)
  guid.writeUInt16LE(0xCD44, 4)
  guid.writeUInt16LE(0x11D0, 6)
  Buffer.from('8cc200c04fc295ee', 'hex').copy(guid, 8)
  return guid
}

function validHandle(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n
    && value !== -1n && value !== INVALID_HANDLE_VALUE
}

/**
 * Load the stable-handle Authenticode verifier on a Windows x64 worker.
 * Verification is cache-only and noninteractive; trust remains pinned by both
 * the leaf certificate SHA-256 and the separately streamed executable digest.
 * @param options - runtime facts and an injectable Koffi loader for ABI tests.
 * @returns the strict verifier consumed by Windows peer-process bindings.
 */
export async function loadWindowsAuthenticodeVerifier(
  options: WindowsAuthenticodeKoffiOptions = {},
): Promise<(executableHandle: bigint, canonicalPath: string) => string> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const mainThread = options.isMainThread ?? isMainThread
  if (platform !== 'win32' || arch !== 'x64' || mainThread) {
    throw new Error('Windows Authenticode verification requires a Windows x64 worker')
  }
  const koffi = options.loadKoffi === undefined
    ? (await import('koffi')).default as unknown as KoffiModule
    : await options.loadKoffi()
  const pointer = koffi.pointer('void')
  const uint32Pointer = koffi.pointer('uint32')
  const fileInfo = koffi.struct('DSH_WINTRUST_FILE_INFO', {
    cbStruct: 'uint32',
    pcwszFilePath: pointer,
    hFile: pointer,
    pgKnownSubject: pointer,
  })
  const trustData = koffi.struct('DSH_WINTRUST_DATA', {
    cbStruct: 'uint32',
    pPolicyCallbackData: pointer,
    pSIPClientData: pointer,
    dwUIChoice: 'uint32',
    fdwRevocationChecks: 'uint32',
    dwUnionChoice: 'uint32',
    pFile: pointer,
    dwStateAction: 'uint32',
    hWVTStateData: pointer,
    pwszURLReference: pointer,
    dwProvFlags: 'uint32',
    dwUIContext: 'uint32',
    pSignatureSettings: pointer,
  })
  if (fileInfo.size !== 32) throw new Error('WINTRUST_FILE_INFO x64 ABI size mismatch')
  if (trustData.size !== 88) throw new Error('WINTRUST_DATA x64 ABI size mismatch')

  const wintrust = koffi.load('wintrust.dll')
  const crypt32 = koffi.load('crypt32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const bind = (library: KoffiLibrary, name: string, result: unknown, args: unknown[]): KoffiFunction =>
    library.func('__stdcall', name, result, args)
  const winVerifyTrust = bind(wintrust, 'WinVerifyTrust', 'int32', [pointer, pointer, koffi.pointer(trustData)])
  const providerDataFromState = bind(wintrust, 'WTHelperProvDataFromStateData', pointer, [pointer])
  const signerFromChain = bind(wintrust, 'WTHelperGetProvSignerFromChain', pointer, [
    pointer, 'uint32', 'int', 'uint32',
  ])
  const certFromChain = bind(wintrust, 'WTHelperGetProvCertFromChain', pointer, [pointer, 'uint32'])
  const certificateProperty = bind(crypt32, 'CertGetCertificateContextProperty', 'int', [
    pointer, 'uint32', pointer, uint32Pointer,
  ])
  const getLastError = bind(kernel32, 'GetLastError', 'uint32', [])
  const action = actionGenericVerifyV2()
  const contexts = new Map<bigint, VerificationContext>()

  const invalidData = (api: string): never => {
    throw new WindowsAuthenticodeError(api, ERROR_INVALID_DATA)
  }
  const certificateError = (): never => {
    throw new WindowsAuthenticodeError('CertGetCertificateContextProperty', Number(getLastError()))
  }
  const newContext = (executableHandle: bigint, canonicalPath: string): VerificationContext => {
    const pathStorage = Buffer.from(`${canonicalPath}\0`, 'utf16le')
    const fileRecord = koffi.alloc(fileInfo, 1)
    koffi.encode(fileRecord, fileInfo, {
      cbStruct: fileInfo.size,
      pcwszFilePath: BigInt(koffi.address(pathStorage)),
      hFile: executableHandle,
      pgKnownSubject: null,
    })
    const trustRecord = koffi.alloc(trustData, 1)
    koffi.encode(trustRecord, trustData, {
      cbStruct: trustData.size,
      pPolicyCallbackData: null,
      pSIPClientData: null,
      dwUIChoice: WTD_UI_NONE,
      fdwRevocationChecks: WTD_REVOKE_NONE,
      dwUnionChoice: WTD_CHOICE_FILE,
      pFile: fileRecord,
      dwStateAction: WTD_STATEACTION_VERIFY,
      hWVTStateData: null,
      pwszURLReference: null,
      dwProvFlags: WTD_REVOCATION_CHECK_NONE | WTD_CACHE_ONLY_URL_RETRIEVAL,
      dwUIContext: 0,
      pSignatureSettings: null,
    })
    return {
      executableHandle, canonicalPath, pathStorage,
      fileInfo: fileRecord, trustData: trustRecord,
    }
  }

  const native: WindowsAuthenticodeNativeApi = {
    beginFileVerification(executableHandle, canonicalPath) {
      const context = newContext(executableHandle, canonicalPath)
      const status = Number(winVerifyTrust(null, action, context.trustData))
      const record = koffi.decode(context.trustData, trustData) as { hWVTStateData?: unknown }
      const stateHandle = validHandle(record.hWVTStateData) ? record.hWVTStateData : null
      if (stateHandle !== null) contexts.set(stateHandle, context)
      return { status, stateHandle }
    },
    publisherCertificateSha256(stateHandle) {
      if (!contexts.has(stateHandle)) invalidData('WTHelperProvDataFromStateData')
      const providerData = providerDataFromState(stateHandle)
      if (!validHandle(providerData)) invalidData('WTHelperProvDataFromStateData')
      const signer = signerFromChain(providerData, 0, 0, 0)
      if (!validHandle(signer)) invalidData('WTHelperGetProvSignerFromChain')
      const providerCert = certFromChain(signer, 0)
      if (!validHandle(providerCert)) invalidData('WTHelperGetProvCertFromChain')
      const certificate = koffi.decode(providerCert, 8, pointer)
      if (!validHandle(certificate)) invalidData('WTHelperGetProvCertFromChain')
      const size = Buffer.alloc(4)
      if (Number(certificateProperty(certificate, CERT_SHA256_HASH_PROP_ID, null, size)) === 0) {
        certificateError()
      }
      if (size.readUInt32LE(0) !== SHA256_BYTES) invalidData('CertGetCertificateContextProperty')
      const digest = Buffer.alloc(SHA256_BYTES)
      if (Number(certificateProperty(certificate, CERT_SHA256_HASH_PROP_ID, digest, size)) === 0) {
        certificateError()
      }
      if (size.readUInt32LE(0) !== SHA256_BYTES) invalidData('CertGetCertificateContextProperty')
      return digest.toString('hex')
    },
    closeFileVerification(executableHandle, canonicalPath, stateHandle) {
      const context = contexts.get(stateHandle)
      if (context === undefined || context.executableHandle !== executableHandle
        || context.canonicalPath !== canonicalPath) return ERROR_INVALID_DATA
      try {
        const record = koffi.decode(context.trustData, trustData) as Record<string, unknown>
        koffi.encode(context.trustData, trustData, {
          ...record,
          dwStateAction: WTD_STATEACTION_CLOSE,
          hWVTStateData: stateHandle,
        })
        return Number(winVerifyTrust(null, action, context.trustData))
      } finally {
        contexts.delete(stateHandle)
      }
    },
  }
  return createWindowsAuthenticodeVerifier(native, {
    ...(options.acceptUntrustedRoot === undefined
      ? {}
      : { acceptUntrustedRoot: options.acceptUntrustedRoot }),
  })
}
