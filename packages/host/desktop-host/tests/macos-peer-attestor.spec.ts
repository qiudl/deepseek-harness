import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createMacOSPeerAttestor, HostAuthorityError } from '../src/index.ts'
import { readMacOSPeerIdentity } from '../src/macos-peer-attestor.ts'

const executable = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-peer-')), 'slark-daemon')
  writeFileSync(path, 'signed daemon fixture', { mode: 0o700 })
  return path
}

describe('macOS Unix peer attestation', () => {
  it('reads LOCAL_PEERPID only after getsockopt populates the output buffer', () => {
    const calls: string[] = []
    const peer = readMacOSPeerIdentity(9, {
      getpeereid: (_fd, uid) => {
        calls.push('getpeereid')
        uid[0] = 501
        return 0
      },
      getsockopt: (_fd, _level, _name, pid, size) => {
        calls.push('getsockopt')
        expect(size[0]).toBe(pid.byteLength)
        pid[0] = 42
        return 0
      },
    })
    expect(calls).toEqual(['getpeereid', 'getsockopt'])
    expect(peer).toEqual({ uid: 501, pid: 42 })
  })

  it('binds the peer fd to PID, executable, Team ID, and executable digest', async () => {
    const path = executable()
    const uid = process.getuid?.() ?? 501
    const attest = createMacOSPeerAttestor({
      allowedTeamIdentifiers: new Set(['TEAM123']),
      bindings: {
        peerIdentity: () => ({ uid, pid: 42 }),
        executablePath: () => path,
        verifyCodeSignature: async (candidate) => {
          expect(candidate).toBe(realpathSync(path))
          return 'TEAM123'
        },
      },
    })
    const evidence = await attest({ _handle: { fd: 9 } } as never)
    expect(evidence.uid).toBe(uid)
    expect(evidence.executableSignatureDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('fails closed for a spoofed Team ID or inaccessible native socket fd', async () => {
    const path = executable()
    const uid = process.getuid?.() ?? 501
    const attest = createMacOSPeerAttestor({
      allowedTeamIdentifiers: new Set(['TEAM123']),
      bindings: {
        peerIdentity: () => ({ uid, pid: 42 }),
        executablePath: () => path,
        verifyCodeSignature: async () => 'ATTACKER',
      },
    })
    await expect(attest({ _handle: { fd: 9 } } as never)).rejects.toBeInstanceOf(HostAuthorityError)
    await expect(attest({} as never)).rejects.toBeInstanceOf(HostAuthorityError)
  })
})
