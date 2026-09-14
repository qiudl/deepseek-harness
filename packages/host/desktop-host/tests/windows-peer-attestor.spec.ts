import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { HostAuthorityError } from '../src/index.ts'
import { createWindowsPeerAttestor } from '../src/windows-peer-attestor.ts'

const daemonBytes = Buffer.from('signed Slark daemon fixture')
const daemonDigest = createHash('sha256').update(daemonBytes).digest('hex')
const publisher = 'A'.repeat(64)
const ownerSid = 'S-1-5-21-1000-2000-3000-1001'
const packageFamilyName = 'Slark.Desktop_1234567890abc'

function bindings(overrides: Partial<Parameters<typeof createWindowsPeerAttestor>[0]['bindings']> = {}) {
  return {
    openClientProcess: vi.fn(() => ({ pid: 42, handle: 101n })),
    currentUserSid: vi.fn(() => ownerSid),
    processOwnerSid: vi.fn((_processHandle: bigint) => ownerSid),
    processPackageIdentity: vi.fn((_processHandle: bigint) => ({
      familyName: packageFamilyName,
      packagePath: String.raw`C:\Program Files\WindowsApps\Slark.Desktop_1.4.11.0_x64__1234567890abc`,
    })),
    openProcessExecutable: vi.fn((_processHandle: bigint) => ({
      handle: 202n,
      path: String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`,
    })),
    verifyAuthenticodePublisher: vi.fn((_executableHandle: bigint) => publisher),
    digestExecutable: vi.fn((_executableHandle: bigint) => daemonDigest),
    closeHandle: vi.fn(),
    ...overrides,
  }
}

describe('Windows named-pipe peer attestation', () => {
  it('accepts a digest-pinned executable inside the matching Store package without Authenticode', async () => {
    const native = bindings({
      openProcessExecutable: vi.fn(() => ({
        handle: 202n,
        path: String.raw`C:\Program Files\WindowsApps\Slark.Desktop_1.4.11.0_x64__1234567890abc\slark.exe`,
      })),
      verifyAuthenticodePublisher: vi.fn(() => { throw new Error('unsigned inner executable') }),
    })
    const attest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set(),
      allowedPackageFamilyNames: new Set([packageFamilyName]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: native,
    })
    await expect(attest(91n)).resolves.toMatchObject({
      packageFamilyName,
      executableSignatureDigest: daemonDigest,
    })
    expect(native.verifyAuthenticodePublisher).not.toHaveBeenCalled()
  })

  it('rejects Store peers outside their protected package path and mixed trust modes', async () => {
    const escaped = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set(),
      allowedPackageFamilyNames: new Set([packageFamilyName]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: bindings(),
    })
    await expect(escaped(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(() => createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedPackageFamilyNames: new Set([packageFamilyName]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: bindings(),
    })).toThrow(HostAuthorityError)
  })

  it('binds the kernel pipe client PID to SID, final executable, publisher, and digest', async () => {
    const native = bindings()
    const attest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: native,
    })
    await expect(attest(91n)).resolves.toEqual({
      pid: 42,
      userSid: ownerSid,
      executablePath: String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`,
      authenticodePublisherThumbprint: publisher,
      executableSignatureDigest: daemonDigest,
    })
    expect(native.openClientProcess).toHaveBeenCalledWith(91n)
    expect(native.processOwnerSid).toHaveBeenCalledWith(101n)
    expect(native.verifyAuthenticodePublisher).toHaveBeenCalledWith(202n)
    expect(native.digestExecutable).toHaveBeenCalledWith(202n)
    expect(native.closeHandle).toHaveBeenNthCalledWith(1, 202n)
    expect(native.closeHandle).toHaveBeenNthCalledWith(2, 101n)
  })

  it('rejects another Windows user before reading or trusting executable bytes', async () => {
    const native = bindings({ processOwnerSid: vi.fn(() => 'S-1-5-21-9-9-9-1002') })
    const attest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: native,
    })
    await expect(attest(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(native.openProcessExecutable).not.toHaveBeenCalled()
    expect(native.digestExecutable).not.toHaveBeenCalled()
    expect(native.closeHandle).toHaveBeenCalledOnce()
    expect(native.closeHandle).toHaveBeenCalledWith(101n)
  })

  it('rejects service identities and alternate-data-stream executable paths', async () => {
    const serviceIdentity = bindings({
      currentUserSid: vi.fn(() => 'S-1-5-18'),
      processOwnerSid: vi.fn((_handle: bigint) => 'S-1-5-18'),
    })
    await expect(createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: serviceIdentity,
    })(91n)).rejects.toBeInstanceOf(HostAuthorityError)

    const alternateStream = bindings({
      openProcessExecutable: vi.fn((_handle: bigint) => ({
        handle: 202n,
        path: String.raw`C:\Program Files\Slark\slark-daemon.exe:payload`,
      })),
    })
    await expect(createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: alternateStream,
    })(91n)).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('rejects a spoofed publisher or a same-name executable with different bytes', async () => {
    const wrongPublisher = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: bindings({ verifyAuthenticodePublisher: vi.fn((_handle: bigint) => 'B'.repeat(64)) }),
    })
    await expect(wrongPublisher(91n)).rejects.toBeInstanceOf(HostAuthorityError)

    const wrongDigest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: bindings({ digestExecutable: vi.fn((_handle: bigint) => createHash('sha256').update('attacker').digest('hex')) }),
    })
    await expect(wrongDigest(91n)).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('rejects non-canonical executable paths and every unavailable native fact', async () => {
    for (const override of [
      { openClientProcess: vi.fn(() => ({ pid: 0, handle: 101n })) },
      { currentUserSid: vi.fn(() => '') },
      { processOwnerSid: vi.fn((_handle: bigint) => '') },
      { openProcessExecutable: vi.fn((_handle: bigint) => ({
        handle: 202n,
        path: String.raw`\\server\share\slark-daemon.exe`,
      })) },
      { verifyAuthenticodePublisher: vi.fn((_handle: bigint) => '') },
      { digestExecutable: vi.fn((_handle: bigint) => { throw new Error('unavailable') }) },
    ]) {
      const attest = createWindowsPeerAttestor({
        allowedPublisherThumbprints: new Set([publisher]),
        allowedExecutableDigests: new Set([daemonDigest]),
        bindings: bindings(override),
      })
      await expect(attest(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    }
  })

  it('takes ownership of valid native handles before rejecting malformed PID or path facts', async () => {
    const malformedPid = bindings({ openClientProcess: vi.fn(() => ({ pid: 0, handle: 101n })) })
    await expect(createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: malformedPid,
    })(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(malformedPid.closeHandle).toHaveBeenCalledOnce()
    expect(malformedPid.closeHandle).toHaveBeenCalledWith(101n)

    const malformedPath = bindings({
      openProcessExecutable: vi.fn((_handle: bigint) => ({
        handle: 202n,
        path: String.raw`\\server\share\slark-daemon.exe`,
      })),
    })
    await expect(createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: malformedPath,
    })(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(malformedPath.closeHandle).toHaveBeenNthCalledWith(1, 202n)
    expect(malformedPath.closeHandle).toHaveBeenNthCalledWith(2, 101n)
  })

  it('fails closed while still releasing both stable handles when cleanup fails', async () => {
    const native = bindings({
      closeHandle: vi.fn((handle: bigint) => {
        if (handle === 202n) throw new Error('CloseHandle failed')
      }),
    })
    const attest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: native,
    })
    await expect(attest(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(native.closeHandle).toHaveBeenNthCalledWith(1, 202n)
    expect(native.closeHandle).toHaveBeenNthCalledWith(2, 101n)
  })

  it('rejects an aliased process/image handle without closing the same native value twice', async () => {
    const native = bindings({
      openProcessExecutable: vi.fn((_handle: bigint) => ({
        handle: 101n,
        path: String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`,
      })),
    })
    const attest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: native,
    })
    await expect(attest(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(native.closeHandle).toHaveBeenCalledOnce()
    expect(native.closeHandle).toHaveBeenCalledWith(101n)
  })

  it('never takes ownership of the caller-owned pipe handle when a native binding aliases it', async () => {
    const pipeAsProcess = bindings({ openClientProcess: vi.fn(() => ({ pid: 42, handle: 91n })) })
    await expect(createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: pipeAsProcess,
    })(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(pipeAsProcess.closeHandle).not.toHaveBeenCalled()

    const pipeAsExecutable = bindings({
      openProcessExecutable: vi.fn((_handle: bigint) => ({
        handle: 91n,
        path: String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`,
      })),
    })
    await expect(createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: pipeAsExecutable,
    })(91n)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(pipeAsExecutable.closeHandle).toHaveBeenCalledOnce()
    expect(pipeAsExecutable.closeHandle).toHaveBeenCalledWith(101n)
  })

  it('rejects empty or malformed trust anchors before accepting a connection', () => {
    expect(() => createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set(),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: bindings(),
    })).toThrow(HostAuthorityError)
    expect(() => createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set(['not-a-digest']),
      bindings: bindings(),
    })).toThrow(HostAuthorityError)
  })

  it('snapshots trust anchors and never closes a handle while a native query is still pending', async () => {
    const allowedPublishers = new Set([publisher])
    const allowedDigests = new Set([daemonDigest])
    const mutatedBindings = bindings({
      verifyAuthenticodePublisher: vi.fn((_handle: bigint) => 'B'.repeat(64)),
      digestExecutable: vi.fn((_handle: bigint) => createHash('sha256').update('attacker').digest('hex')),
    })
    const snapshotted = createWindowsPeerAttestor({
      allowedPublisherThumbprints: allowedPublishers,
      allowedExecutableDigests: allowedDigests,
      bindings: mutatedBindings,
    })
    allowedPublishers.add('B'.repeat(64))
    allowedDigests.add(createHash('sha256').update('attacker').digest('hex'))
    await expect(snapshotted(91n)).rejects.toBeInstanceOf(HostAuthorityError)

    let finishOwnerQuery: ((sid: string) => void) | undefined
    const pendingOwner = new Promise<string>((resolve) => { finishOwnerQuery = resolve })
    const pendingBindings = bindings({
      currentUserSid: vi.fn(async () => { throw new Error('token unavailable') }),
      processOwnerSid: vi.fn((_handle: bigint) => pendingOwner),
    })
    const pending = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: pendingBindings,
    })(91n)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(pendingBindings.closeHandle).not.toHaveBeenCalled()
    finishOwnerQuery?.(ownerSid)
    await expect(pending).rejects.toBeInstanceOf(HostAuthorityError)
    expect(pendingBindings.closeHandle).toHaveBeenCalledWith(101n)
  })
})
