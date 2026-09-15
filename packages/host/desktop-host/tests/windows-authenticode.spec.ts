import { describe, expect, it, vi } from 'vitest'
import {
  WindowsAuthenticodeError,
  createWindowsAuthenticodeVerifier,
} from '../src/windows-authenticode.ts'

const path = String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`

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

  it('accepts only WinVerifyTrust status zero and closes any returned state after failure', () => {
    const api = native({ beginFileVerification: vi.fn(() => ({ status: -2_146_762_496, stateHandle: 901n })) })
    const error = (() => {
      try { createWindowsAuthenticodeVerifier(api)(802n, path) } catch (caught) { return caught }
    })()
    expect(error).toBeInstanceOf(WindowsAuthenticodeError)
    expect(error).toMatchObject({ api: 'WinVerifyTrust', trustStatus: -2_146_762_496 })
    expect(api.publisherCertificateSha256).not.toHaveBeenCalled()
    expect(api.closeFileVerification).toHaveBeenCalledWith(802n, path, 901n)
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
