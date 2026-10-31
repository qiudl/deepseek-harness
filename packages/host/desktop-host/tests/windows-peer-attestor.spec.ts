import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createHostDiagnostics, type HostDiagnostics } from '../src/host-diagnostics.ts'
import { HostAuthorityError } from '../src/index.ts'
import { createWindowsPeerAttestor } from '../src/windows-peer-attestor.ts'

const daemonBytes = Buffer.from('signed Slark daemon fixture')
const daemonDigest = createHash('sha256').update(daemonBytes).digest('hex')
const publisher = 'A'.repeat(64)
const ownerSid = 'S-1-5-21-1000-2000-3000-1001'
const daemonPath = String.raw`C:\Program Files\Slark\slark-daemon-windows-x64.exe`

function bindings(overrides: Partial<Parameters<typeof createWindowsPeerAttestor>[0]['bindings']> = {}) {
  return {
    openClientProcess: vi.fn(() => ({ pid: 42, handle: 101n })),
    currentUserSid: vi.fn(() => ownerSid),
    processOwnerSid: vi.fn((_processHandle: bigint) => ownerSid),
    openProcessExecutable: vi.fn((_processHandle: bigint) => ({
      handle: 202n,
      path: daemonPath,
    })),
    verifyAuthenticodePublisher: vi.fn((_executableHandle: bigint) => publisher),
    digestExecutable: vi.fn((_executableHandle: bigint) => daemonDigest),
    closeHandle: vi.fn(),
    ...overrides,
  }
}

function diagnosticsSink() {
  const record = vi.fn<HostDiagnostics['record']>()
  return { diagnostics: { record }, record }
}

describe('Windows named-pipe peer attestation', () => {
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

  it('rejects invalid caller-owned pipe handles before any native query', async () => {
    const native = bindings()
    const attest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: native,
    })
    await expect(attest(0n)).rejects.toBeInstanceOf(HostAuthorityError)
    await expect(attest('91' as unknown as bigint)).rejects.toBeInstanceOf(HostAuthorityError)
    expect(native.openClientProcess).not.toHaveBeenCalled()
    expect(native.closeHandle).not.toHaveBeenCalled()
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

  it('records a stable reason for every rejected attestation step while still rejecting unauthorized', async () => {
    const rejections: readonly {
      readonly reason: string
      readonly bindings?: Partial<Parameters<typeof createWindowsPeerAttestor>[0]['bindings']>
      readonly pipeHandle?: bigint
    }[] = [
      { reason: 'pipe_handle_invalid', pipeHandle: 0n },
      {
        reason: 'process_binding_failed',
        bindings: { openClientProcess: vi.fn(() => { throw new Error('kernel query failed') }) },
      },
      { reason: 'process_identity_invalid', bindings: { openClientProcess: vi.fn(() => ({ pid: 0, handle: 101n })) } },
      { reason: 'process_identity_invalid', bindings: { openClientProcess: vi.fn(() => ({ pid: 42, handle: 91n })) } },
      { reason: 'owner_sid_unavailable', bindings: { currentUserSid: vi.fn(() => { throw new Error('token') }) } },
      { reason: 'owner_sid_invalid', bindings: { processOwnerSid: vi.fn((_handle: bigint) => '') } },
      { reason: 'owner_sid_mismatch', bindings: { processOwnerSid: vi.fn((_handle: bigint) => 'S-1-5-21-9-9-9-1002') } },
      {
        reason: 'executable_binding_failed',
        bindings: { openProcessExecutable: vi.fn(() => { throw new Error('image unavailable') }) },
      },
      {
        reason: 'executable_handle_invalid',
        bindings: { openProcessExecutable: vi.fn(() => ({ handle: 101n, path: daemonPath })) },
      },
      {
        reason: 'path_invalid',
        bindings: { openProcessExecutable: vi.fn(() => ({ handle: 202n, path: String.raw`\\server\share\slark.exe` })) },
      },
      {
        reason: 'publisher_unavailable',
        bindings: { verifyAuthenticodePublisher: vi.fn(() => { throw new Error('signature unavailable') }) },
      },
      { reason: 'publisher_invalid', bindings: { verifyAuthenticodePublisher: vi.fn(() => '') } },
      { reason: 'publisher_not_allowed', bindings: { verifyAuthenticodePublisher: vi.fn(() => 'B'.repeat(64)) } },
      {
        reason: 'digest_unavailable',
        bindings: { digestExecutable: vi.fn(() => { throw new Error('read failed') }) },
      },
      { reason: 'digest_invalid', bindings: { digestExecutable: vi.fn(() => 'not-a-digest') } },
      {
        reason: 'digest_not_allowed',
        bindings: { digestExecutable: vi.fn(() => createHash('sha256').update('attacker').digest('hex')) },
      },
      {
        reason: 'cleanup_failed',
        bindings: { closeHandle: vi.fn(() => { throw new Error('CloseHandle failed') }) },
      },
    ]
    for (const rejection of rejections) {
      const sink = diagnosticsSink()
      const attest = createWindowsPeerAttestor({
        allowedPublisherThumbprints: new Set([publisher]),
        allowedExecutableDigests: new Set([daemonDigest]),
        bindings: bindings(rejection.bindings ?? {}),
        diagnostics: sink.diagnostics,
      })
      await expect(attest(rejection.pipeHandle ?? 91n)).rejects.toMatchObject({ code: 'unauthorized' })
      expect(sink.record).toHaveBeenCalledOnce()
      expect(sink.record).toHaveBeenCalledWith({ event: 'peer-attest', reason: rejection.reason })
    }
  })

  it('records nothing when the accepted peer proves every native fact', async () => {
    const sink = diagnosticsSink()
    const attest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: bindings(),
      diagnostics: sink.diagnostics,
    })

    await expect(attest(91n)).resolves.toMatchObject({ pid: 42, executablePath: daemonPath })
    expect(sink.record).not.toHaveBeenCalled()
  })

  it('writes only the reason code, never the rejected executable path', async () => {
    const appended: Buffer[] = []
    const attest = createWindowsPeerAttestor({
      allowedPublisherThumbprints: new Set([publisher]),
      allowedExecutableDigests: new Set([daemonDigest]),
      bindings: bindings({ verifyAuthenticodePublisher: vi.fn(() => 'B'.repeat(64)) }),
      diagnostics: {
        record: (sink) => {
          createHostDiagnostics({
            root: String.raw`C:\Slark\env`,
            now: () => 0,
            fileOperations: {
              ensureDirectory: () => undefined,
              append: (_path, contents) => { appended.push(contents) },
              length: () => undefined,
              replace: () => undefined,
            },
          }).record(sink)
        },
      },
    })

    await expect(attest(91n)).rejects.toMatchObject({ code: 'unauthorized' })
    const written = Buffer.concat(appended).toString('utf8')
    expect(written).toContain('"event":"peer-attest"')
    expect(written).toContain('"reason":"publisher_not_allowed"')
    expect(written).not.toContain('Slark')
    expect(written).not.toContain('slark-daemon')
    expect(written).not.toContain('\\')
    expect(written).not.toContain(ownerSid)
  })
})
