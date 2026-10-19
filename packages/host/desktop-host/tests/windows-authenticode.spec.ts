import { describe, expect, it, vi } from 'vitest'
import {
  WindowsAuthenticodeError,
  createWindowsAuthenticodeVerifier,
} from '../src/windows-authenticode.ts'

const path = String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`
const CERT_E_UNTRUSTEDROOT = -2_146_762_487
const TRUST_E_NOSIGNATURE = -2_146_762_496
const TRUST_E_BAD_DIGEST = -2_146_869_232

function native(overrides: Record<string, unknown> = {}) {
  return {
    beginFileVerification: vi.fn(() => ({ status: 0, stateHandle: 901n })),
    publisherCertificateSha256: vi.fn(() => 'ab'.repeat(32)),
    closeFileVerification: vi.fn(() => 0),
    ...overrides,
  }
}

describe('Windows Authenticode stable-handle verifier', () => {
  it('returns an uppercase SHA-256 publisher thumbprint and always closes WinTrust state', () => {
    const api = native()
    const verify = createWindowsAuthenticodeVerifier(api)
    expect(verify(802n, path)).toBe('AB'.repeat(32))
    expect(api.beginFileVerification).toHaveBeenCalledWith(802n, path)
    expect(api.publisherCertificateSha256).toHaveBeenCalledWith(901n)
    expect(api.closeFileVerification).toHaveBeenCalledWith(802n, path, 901n)
  })

  it('accepts CERT_E_UNTRUSTEDROOT and leaves the pinned publisher thumbprint authoritative', () => {
    const api = native({ beginFileVerification: vi.fn(() => ({ status: CERT_E_UNTRUSTEDROOT, stateHandle: 901n })) })
    expect(createWindowsAuthenticodeVerifier(api)(802n, path)).toBe('AB'.repeat(32))
    expect(api.publisherCertificateSha256).toHaveBeenCalledWith(901n)
    expect(api.closeFileVerification).toHaveBeenCalledWith(802n, path, 901n)
  })

  it('keeps every other nonzero WinVerifyTrust status fatal and closes any returned state', () => {
    for (const trustStatus of [TRUST_E_NOSIGNATURE, TRUST_E_BAD_DIGEST]) {
      const api = native({ beginFileVerification: vi.fn(() => ({ status: trustStatus, stateHandle: 901n })) })
      const error = (() => {
        try { createWindowsAuthenticodeVerifier(api)(802n, path) } catch (caught) { return caught }
      })()
      expect(error).toBeInstanceOf(WindowsAuthenticodeError)
      expect(error).toMatchObject({ api: 'WinVerifyTrust', trustStatus })
      expect(api.publisherCertificateSha256).not.toHaveBeenCalled()
      expect(api.closeFileVerification).toHaveBeenCalledWith(802n, path, 901n)
    }
  })

  it('reports the untrusted-root status itself when WinTrust retains no state to inspect', () => {
    const api = native({ beginFileVerification: vi.fn(() => ({ status: CERT_E_UNTRUSTEDROOT, stateHandle: null })) })
    const error = (() => {
      try { createWindowsAuthenticodeVerifier(api)(802n, path) } catch (caught) { return caught }
    })()
    expect(error).toMatchObject({ api: 'WinVerifyTrust', trustStatus: CERT_E_UNTRUSTEDROOT })
    expect(api.publisherCertificateSha256).not.toHaveBeenCalled()
    expect(api.closeFileVerification).not.toHaveBeenCalled()
  })

  it('rejects missing state, malformed thumbprints, and invalid caller handles', () => {
    for (const api of [
      native({ beginFileVerification: vi.fn(() => ({ status: 0, stateHandle: null })) }),
      native({ publisherCertificateSha256: vi.fn(() => 'A'.repeat(40)) }),
      native({ publisherCertificateSha256: vi.fn(() => 'not-a-thumbprint') }),
    ]) {
      expect(() => createWindowsAuthenticodeVerifier(api as never)(802n, path))
        .toThrow(WindowsAuthenticodeError)
    }
    expect(() => createWindowsAuthenticodeVerifier(native())(0n, path))
      .toThrow(WindowsAuthenticodeError)
    expect(() => createWindowsAuthenticodeVerifier(native())(802n, ''))
      .toThrow(WindowsAuthenticodeError)
  })

  it('preserves the primary verification failure if state cleanup also fails', () => {
    const api = native({
      publisherCertificateSha256: vi.fn(() => { throw new WindowsAuthenticodeError('CertGetCertificateContextProperty', 5) }),
      closeFileVerification: vi.fn(() => -1),
    })
    const error = (() => {
      try { createWindowsAuthenticodeVerifier(api)(802n, path) } catch (caught) { return caught }
    })()
    expect(error).toMatchObject({ api: 'CertGetCertificateContextProperty', trustStatus: 5 })
    expect(api.closeFileVerification).toHaveBeenCalledOnce()
  })

  it('fails closed when a successful verification cannot release WinTrust state', () => {
    const api = native({ closeFileVerification: vi.fn(() => -1) })
    const error = (() => {
      try { createWindowsAuthenticodeVerifier(api)(802n, path) } catch (caught) { return caught }
    })()
    expect(error).toMatchObject({ api: 'WinVerifyTrust(WTD_STATEACTION_CLOSE)', trustStatus: -1 })
  })

  it('normalizes non-Error native failures and a missing normalized result', () => {
    for (const api of [
      native({ publisherCertificateSha256: vi.fn(() => { throw 'native publisher failure' }) }),
      native({ closeFileVerification: vi.fn(() => { throw 'native close failure' }) }),
      native({ publisherCertificateSha256: vi.fn(() => ({
        toString: () => 'ab'.repeat(32),
        toUpperCase: () => undefined,
      })) }),
    ]) expect(() => createWindowsAuthenticodeVerifier(api as never)(802n, path))
      .toThrow(WindowsAuthenticodeError)
  })
})
