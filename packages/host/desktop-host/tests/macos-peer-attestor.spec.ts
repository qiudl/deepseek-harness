import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createMacOSPeerAttestor, HostAuthorityError } from '../src/index.ts'
import {
  parseMacOSProcessExecutable,
  readMacOSPeerIdentity,
  resolveMacOSProcessExecutable,
} from '../src/macos-peer-attestor.ts'

const executable = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'dsh-peer-')), 'slark-daemon')
  writeFileSync(path, 'signed daemon fixture', { mode: 0o700 })
  return path
}

describe('macOS Unix peer attestation', () => {
  it.runIf(process.platform === 'darwin')('fails closed through the real kernel, proc, and codesign bindings for an untrusted Node peer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-peer-native-'))
    const socketPath = join(root, 'peer.sock')
    const server = createServer()
    onTestFinished(async () => {
      server.close()
      await once(server, 'close').catch(() => {})
      rmSync(root, { recursive: true, force: true })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    const attestation = new Promise((resolve, reject) => {
      server.once('connection', (socket) => {
        createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(['UNTRUSTEDTEAM']) })(socket)
          .then(resolve, reject).finally(() => { socket.destroy() })
      })
    })
    const client = createConnection(socketPath)
    onTestFinished(() => { client.destroy() })
    await once(client, 'connect')
    await expect(attestation).rejects.toBeInstanceOf(HostAuthorityError)
  })

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

  it('rejects incomplete or invalid native peer credentials', () => {
    const valid = {
      getpeereid: (_fd: number, uid: Uint32Array) => { uid[0] = 501; return 0 },
      getsockopt: (_fd: number, _level: number, _name: number, pid: Int32Array) => { pid[0] = 42; return 0 },
    }
    expect(() => readMacOSPeerIdentity(9, { ...valid, getpeereid: () => -1 })).toThrow(HostAuthorityError)
    expect(() => readMacOSPeerIdentity(9, { ...valid, getsockopt: () => -1 })).toThrow(HostAuthorityError)
    expect(() => readMacOSPeerIdentity(9, {
      ...valid,
      getsockopt: (_fd, _level, _name, pid, size) => { pid[0] = 42; size[0] = 0; return 0 },
    })).toThrow(HostAuthorityError)
    expect(() => readMacOSPeerIdentity(9, {
      ...valid,
      getsockopt: (_fd, _level, _name, pid) => { pid[0] = 0; return 0 },
    })).toThrow(HostAuthorityError)
  })

  it('falls back to the launchd process text mapping when proc_pidpath returns zero', async () => {
    const calls: number[] = []
    const path = await resolveMacOSProcessExecutable(42, () => 0, async (pid) => {
      calls.push(pid)
      return 'p42\nftxt\nn/usr/local/libexec/slark-daemon\n'
    })
    expect(calls).toEqual([42])
    expect(path).toBe('/usr/local/libexec/slark-daemon')
  })

  it('uses a complete proc_pidpath result without invoking lsof', async () => {
    const path = await resolveMacOSProcessExecutable(42, (_pid, buffer) => {
      return buffer.write('/Applications/Slark.app/Contents/MacOS/Slark')
    }, async () => { throw new Error('lsof must not run') })
    expect(path).toBe('/Applications/Slark.app/Contents/MacOS/Slark')
  })

  it.runIf(process.platform === 'darwin')('resolves the current executable through the real lsof fallback', async () => {
    const path = await resolveMacOSProcessExecutable(process.pid, () => 0)
    expect(realpathSync(path)).toBe(realpathSync(process.execPath))
  })

  it('selects the primary text mapping and rejects malformed lsof identity output', () => {
    expect(parseMacOSProcessExecutable('p42\nftxt\nn/bin/a\nftxt\nn/usr/lib/dyld\n', 42)).toBe('/bin/a')
    expect(() => parseMacOSProcessExecutable('p43\nftxt\nn/bin/a\n', 42)).toThrow(HostAuthorityError)
    expect(() => parseMacOSProcessExecutable('p42\nftxt\n', 42)).toThrow(HostAuthorityError)
    expect(() => parseMacOSProcessExecutable('p42\nf1\nn/bin/a\n', 42)).toThrow(HostAuthorityError)
    expect(() => parseMacOSProcessExecutable('p42\nftxt\nnrelative\n', 42)).toThrow(HostAuthorityError)
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
          expect(candidate).not.toBe(realpathSync(path))
          expect(readFileSync(candidate, 'utf8')).toBe('signed daemon fixture')
          return 'TEAM123'
        },
      },
    })
    const evidence = await attest({ _handle: { fd: 9 } } as never)
    expect(evidence.uid).toBe(uid)
    expect(evidence.executableSignatureDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('verifies a bundled app executable with its Info.plist still attached', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-peer-bundle-'))
    const contents = join(root, 'Slark.app', 'Contents')
    const executablePath = join(contents, 'MacOS', 'Slark')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    writeFileSync(join(contents, 'Info.plist'), 'signed bundle fixture')
    writeFileSync(executablePath, 'signed app executable fixture', { mode: 0o700 })
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const uid = process.getuid?.() ?? 501
    const attest = createMacOSPeerAttestor({
      allowedTeamIdentifiers: new Set(['TEAM123']),
      bindings: {
        peerIdentity: () => ({ uid, pid: 42 }),
        executablePath: () => executablePath,
        verifyCodeSignature: async (candidate) => {
          expect(candidate).toBe(realpathSync(executablePath))
          expect(readFileSync(join(contents, 'Info.plist'), 'utf8')).toBe('signed bundle fixture')
          return 'TEAM123'
        },
      },
    })
    await expect(attest({ _handle: { fd: 9 } } as never)).resolves.toMatchObject({ uid })
  })

  it('rejects a bundled app executable changed while its bundle signature is verified', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-peer-bundle-race-'))
    const executablePath = join(root, 'Slark.app', 'Contents', 'MacOS', 'Slark')
    mkdirSync(join(root, 'Slark.app', 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(executablePath, 'signed app executable fixture', { mode: 0o700 })
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const uid = process.getuid?.() ?? 501
    const attest = createMacOSPeerAttestor({
      allowedTeamIdentifiers: new Set(['TEAM123']),
      bindings: {
        peerIdentity: () => ({ uid, pid: 42 }),
        executablePath: () => executablePath,
        verifyCodeSignature: async () => {
          writeFileSync(executablePath, 'unsigned replacement bytes')
          return 'TEAM123'
        },
      },
    })
    await expect(attest({ _handle: { fd: 9 } } as never)).rejects.toBeInstanceOf(HostAuthorityError)
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

  it('rejects invalid trust roots, peer facts, paths, permissions, and binding failures', async () => {
    expect(() => createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set() })).toThrow(HostAuthorityError)
    expect(() => createMacOSPeerAttestor({ allowedTeamIdentifiers: new Set(['bad team']) })).toThrow(HostAuthorityError)
    const uid = process.getuid?.() ?? 501
    const path = executable()
    const bindings = {
      peerIdentity: () => ({ uid, pid: 42 }),
      executablePath: () => path,
      verifyCodeSignature: async () => 'TEAM123',
    }
    const attest = (overrides: Partial<typeof bindings>) => createMacOSPeerAttestor({
      allowedTeamIdentifiers: new Set(['TEAM123']), bindings: { ...bindings, ...overrides },
    })({ _handle: { fd: 9 } } as never)
    await expect(attest({ peerIdentity: () => ({ uid: -1, pid: 42 }) })).rejects.toBeInstanceOf(HostAuthorityError)
    await expect(attest({ peerIdentity: () => ({ uid, pid: 0 }) })).rejects.toBeInstanceOf(HostAuthorityError)
    await expect(attest({ executablePath: () => 'relative' })).rejects.toBeInstanceOf(HostAuthorityError)
    await expect(attest({ executablePath: () => { throw new Error('native failure') } })).rejects.toBeInstanceOf(HostAuthorityError)
    chmodSync(path, 0o722)
    await expect(attest({})).rejects.toBeInstanceOf(HostAuthorityError)
    const directory = join(mkdtempSync(join(tmpdir(), 'dsh-peer-dir-')), 'daemon')
    mkdirSync(directory)
    await expect(attest({ executablePath: () => directory })).rejects.toBeInstanceOf(HostAuthorityError)
    const oversized = executable()
    truncateSync(oversized, 512 * 1024 * 1024 + 1)
    await expect(attest({ executablePath: () => oversized })).rejects.toBeInstanceOf(HostAuthorityError)
    const empty = executable()
    truncateSync(empty, 0)
    await expect(attest({ executablePath: () => empty })).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('rejects executable bytes changed while the code signature is verified', async () => {
    const path = executable()
    const uid = process.getuid?.() ?? 501
    const attest = createMacOSPeerAttestor({
      allowedTeamIdentifiers: new Set(['TEAM123']),
      bindings: {
        peerIdentity: () => ({ uid, pid: 42 }),
        executablePath: () => path,
        verifyCodeSignature: async () => {
          writeFileSync(path, 'unsigned replacement bytes', { mode: 0o700 })
          return 'TEAM123'
        },
      },
    })
    await expect(attest({ _handle: { fd: 9 } } as never)).rejects.toBeInstanceOf(HostAuthorityError)
  })
})
