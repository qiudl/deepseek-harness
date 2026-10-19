import { win32 } from 'node:path'

const SHA256_CERTIFICATE_THUMBPRINT = /^[0-9a-f]{64}$/iu
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const INVALID_HANDLE_VALUE = 0xFFFF_FFFF_FFFF_FFFFn
/** WinVerifyTrust HRESULT 0x800B0109: an intact signature whose root chains to no trusted anchor. */
const CERT_E_UNTRUSTEDROOT = -2_146_762_487

/** WinTrust verification result retaining the state handle needed for mandatory cleanup. */
export interface WindowsAuthenticodeBeginResult {
  readonly status: number
  readonly stateHandle: bigint | null
}

/** Native WinTrust/CryptoAPI operations executed synchronously in the Windows worker. */
export interface WindowsAuthenticodeNativeApi {
  beginFileVerification(executableHandle: bigint, canonicalPath: string): WindowsAuthenticodeBeginResult
  publisherCertificateSha256(stateHandle: bigint): string
  closeFileVerification(executableHandle: bigint, canonicalPath: string, stateHandle: bigint): number
}

/** Exact WinTrust or CryptoAPI failure retained before authority-layer redaction. */
export class WindowsAuthenticodeError extends Error {
  readonly api: string
  readonly trustStatus: number

  constructor(api: string, trustStatus: number) {
    super(`${api} failed with status ${trustStatus}`)
    this.name = 'WindowsAuthenticodeError'
    this.api = api
    this.trustStatus = trustStatus
  }
}

function validHandle(handle: bigint | null): handle is bigint {
  return typeof handle === 'bigint' && handle > 0n
    && handle !== -1n && handle !== INVALID_HANDLE_VALUE
}

function validCanonicalPath(path: string): boolean {
  return DRIVE_ROOTED_PATH.test(path)
    && !CONTROL_CHARACTER.test(path)
    && !path.slice(2).includes(':')
    && win32.normalize(path) === path
}

/**
 * Build the strict stable-handle Authenticode verifier.
 * Status zero and CERT_E_UNTRUSTEDROOT proceed to the signer certificate SHA-256, which the caller
 * pins (REQ-20261019-0004); every other WinVerifyTrust status fails closed. Every returned state
 * handle is closed, and cleanup failure rejects an otherwise successful verification.
 * @param api - worker-local WinTrust and certificate-chain operations.
 * @returns a publisher certificate SHA-256 verifier for the already-open executable.
 */
export function createWindowsAuthenticodeVerifier(
  api: WindowsAuthenticodeNativeApi,
): (executableHandle: bigint, canonicalPath: string) => string {
  return (executableHandle, canonicalPath) => {
    if (!validHandle(executableHandle) || !validCanonicalPath(canonicalPath)) {
      throw new WindowsAuthenticodeError('WinVerifyTrust', 13)
    }
    const begun = api.beginFileVerification(executableHandle, canonicalPath)
    const stateHandle = begun.stateHandle
    let result: string | undefined
    let failure: Error | undefined
    if (begun.status !== 0 && begun.status !== CERT_E_UNTRUSTEDROOT) {
      failure = new WindowsAuthenticodeError('WinVerifyTrust', begun.status)
    } else if (!validHandle(stateHandle)) {
      failure = new WindowsAuthenticodeError('WinVerifyTrust', begun.status === 0 ? 13 : begun.status)
    } else {
      try {
        const thumbprint = api.publisherCertificateSha256(stateHandle)
        if (!SHA256_CERTIFICATE_THUMBPRINT.test(thumbprint)) {
          throw new WindowsAuthenticodeError('CertGetCertificateContextProperty', 13)
        }
        result = thumbprint.toUpperCase()
      } catch (error) {
        failure = error instanceof Error
          ? error
          : new WindowsAuthenticodeError('CertGetCertificateContextProperty', 13)
      }
    }
    if (validHandle(stateHandle)) {
      try {
        const closeStatus = api.closeFileVerification(executableHandle, canonicalPath, stateHandle)
        if (closeStatus !== 0) {
          throw new WindowsAuthenticodeError('WinVerifyTrust(WTD_STATEACTION_CLOSE)', closeStatus)
        }
      } catch (error) {
        failure ??= error instanceof Error
          ? error
          : new WindowsAuthenticodeError('WinVerifyTrust(WTD_STATEACTION_CLOSE)', 13)
      }
    }
    if (failure !== undefined || result === undefined) {
      throw failure ?? new WindowsAuthenticodeError('WinVerifyTrust', 13)
    }
    return result
  }
}
