import { describe, expect, it, vi } from 'vitest'
import { HostAuthorityError } from '../src/index.ts'
import { WindowsNamedPipeNativeError } from '../src/windows-named-pipe-native.ts'
import { resolveWindowsNamedPipePolicy } from '../src/windows-named-pipe-policy.ts'
import {
  withAcceptedWindowsNamedPipe,
  withCancellableAcceptedWindowsNamedPipe,
} from '../src/windows-named-pipe-lifecycle.ts'

const policy = resolveWindowsNamedPipePolicy({
  installationId: 'slark-dsh-e3a7a33ed99e8ce5b4d3522d96336dffa8da2820',
  endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
  userSid: 'S-1-5-21-1000-2000-3000-1001',
})

function bindings(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  return {
    calls,
    native: {
      createSecurityDescriptor: vi.fn(() => { calls.push('descriptor:create'); return 11n }),
      freeSecurityDescriptor: vi.fn((_descriptor: bigint) => { calls.push('descriptor:free') }),
      createNamedPipe: vi.fn(() => { calls.push('pipe:create'); return 91n }),
      connectNamedPipe: vi.fn(async (_handle: bigint) => { calls.push('pipe:connect'); return 'connected' as const }),
      disconnectNamedPipe: vi.fn((_handle: bigint) => { calls.push('pipe:disconnect') }),
      closeHandle: vi.fn((_handle: bigint) => { calls.push('pipe:close') }),
      ...overrides,
    },
  }
}

describe('Windows named-pipe native lifecycle', () => {
  it('frees the descriptor before accept and retains the pipe through attestation and service', async () => {
    const fixture = bindings()
    await expect(withAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      attest: vi.fn(async (handle) => { fixture.calls.push(`attest:${handle}`); return { pid: 42 } }),
      serve: vi.fn(async (handle, evidence) => {
        fixture.calls.push(`serve:${handle}:${(evidence as { pid: number }).pid}`)
        return 'served'
      }),
    })).resolves.toBe('served')
    expect(fixture.calls).toEqual([
      'descriptor:create', 'pipe:create', 'descriptor:free', 'pipe:connect',
      'attest:91', 'serve:91:42', 'pipe:disconnect', 'pipe:close',
    ])
  })

  it('accepts the documented already-connected race as a connected client', async () => {
    const fixture = bindings({ connectNamedPipe: vi.fn(async () => 'already_connected' as const) })
    await expect(withAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      attest: async () => ({ pid: 42 }),
      serve: async () => 'served',
    })).resolves.toBe('served')
    expect(fixture.native.disconnectNamedPipe).toHaveBeenCalledWith(91n)
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(91n)
  })

  it('frees descriptor allocation after pipe creation fails without closing an invalid handle', async () => {
    const fixture = bindings({ createNamedPipe: vi.fn(() => { throw new Error('CreateNamedPipeW failed') }) })
    await expect(withAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      attest: async () => ({ pid: 42 }),
      serve: async () => 'unreachable',
    })).rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.freeSecurityDescriptor).toHaveBeenCalledWith(11n)
    expect(fixture.native.connectNamedPipe).not.toHaveBeenCalled()
    expect(fixture.native.closeHandle).not.toHaveBeenCalled()
  })

  it('rejects Win32 invalid-handle sentinels at both descriptor and pipe ownership boundaries', async () => {
    for (const fixture of [
      bindings({ createSecurityDescriptor: vi.fn(() => 0xFFFF_FFFF_FFFF_FFFFn) }),
      bindings({ createNamedPipe: vi.fn(() => -1n) }),
    ]) {
      await expect(withAcceptedWindowsNamedPipe({
        policy,
        bindings: fixture.native,
        attest: async () => ({ pid: 42 }),
        serve: async () => 'unreachable',
      })).rejects.toBeInstanceOf(HostAuthorityError)
      expect(fixture.native.connectNamedPipe).not.toHaveBeenCalled()
    }
  })

  it('closes a created pipe if descriptor cleanup fails and never accepts a client', async () => {
    const fixture = bindings({
      freeSecurityDescriptor: vi.fn(() => { throw new Error('LocalFree failed') }),
    })
    await expect(withAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      attest: async () => ({ pid: 42 }),
      serve: async () => 'unreachable',
    })).rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.connectNamedPipe).not.toHaveBeenCalled()
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(91n)
  })

  it('disconnects and closes after connect, attestation, or service failures', async () => {
    for (const failure of ['connect', 'attest', 'serve'] as const) {
      const fixture = bindings(failure === 'connect' ? {
        connectNamedPipe: vi.fn(async () => { throw new Error('ConnectNamedPipe failed') }),
      } : {})
      await expect(withAcceptedWindowsNamedPipe({
        policy,
        bindings: fixture.native,
        attest: async () => {
          if (failure === 'attest') throw new Error('untrusted peer')
          return { pid: 42 }
        },
        serve: async () => {
          if (failure === 'serve') throw new Error('protocol failed')
          return 'served'
        },
      })).rejects.toBeInstanceOf(HostAuthorityError)
      expect(fixture.native.disconnectNamedPipe).toHaveBeenCalledTimes(failure === 'connect' ? 0 : 1)
      expect(fixture.native.closeHandle).toHaveBeenCalledWith(91n)
    }
  })

  it('attempts both connected-pipe cleanup operations and fails closed on cleanup errors', async () => {
    const fixture = bindings({
      disconnectNamedPipe: vi.fn(() => { throw new Error('DisconnectNamedPipe failed') }),
      closeHandle: vi.fn(() => { throw new Error('CloseHandle failed') }),
    })
    await expect(withAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      attest: async () => ({ pid: 42 }),
      serve: async () => 'served',
    })).rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.disconnectNamedPipe).toHaveBeenCalledWith(91n)
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(91n)
  })

  it('returns an explicit stopped result without creating a pipe when stop is already requested', async () => {
    const fixture = bindings()
    await expect(withCancellableAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      stopRequested: () => true,
      attest: async () => ({ pid: 42 }),
      serve: async () => 'unreachable',
    })).resolves.toEqual({ state: 'stopped' })
    expect(fixture.native.createSecurityDescriptor).not.toHaveBeenCalled()
  })

  it('frees a valid descriptor when stop wins before pipe creation', async () => {
    let stopped = false
    const fixture = bindings({
      createSecurityDescriptor: vi.fn(() => { stopped = true; return 11n }),
    })
    await expect(withCancellableAcceptedWindowsNamedPipe({
      policy, bindings: fixture.native, stopRequested: () => stopped,
      attest: async () => ({ pid: 42 }), serve: async () => 'unreachable',
    })).resolves.toEqual({ state: 'stopped' })
    expect(fixture.native.freeSecurityDescriptor).toHaveBeenCalledWith(11n)
    expect(fixture.native.createNamedPipe).not.toHaveBeenCalled()
  })

  it('closes a prepared pipe without accepting when stop wins before the blocking connect', async () => {
    let stopped = false
    const fixture = bindings({
      createNamedPipe: vi.fn(() => { stopped = true; return 91n }),
    })
    await expect(withCancellableAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      stopRequested: () => stopped,
      attest: async () => ({ pid: 42 }),
      serve: async () => 'unreachable',
    })).resolves.toEqual({ state: 'stopped' })
    expect(fixture.native.connectNamedPipe).not.toHaveBeenCalled()
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(91n)
    expect(fixture.native.disconnectNamedPipe).not.toHaveBeenCalled()
  })

  it('fails closed when pre-connect stop cleanup fails', async () => {
    let stopped = false
    const fixture = bindings({
      createNamedPipe: vi.fn(() => { stopped = true; return 91n }),
      closeHandle: vi.fn(() => { throw new Error('CloseHandle failed') }),
    })
    await expect(withCancellableAcceptedWindowsNamedPipe({
      policy, bindings: fixture.native, stopRequested: () => stopped,
      attest: async () => ({ pid: 42 }), serve: async () => 'unreachable',
    })).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('rejects undocumented connect results', async () => {
    const fixture = bindings({ connectNamedPipe: vi.fn(async () => 'unexpected') })
    await expect(withAcceptedWindowsNamedPipe({
      policy, bindings: fixture.native,
      attest: async () => ({ pid: 42 }), serve: async () => 'unreachable',
    })).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('stops after connect or attestation without serving', async () => {
    for (const stopAt of ['connect', 'attest'] as const) {
      let stopped = false
      const fixture = bindings(stopAt === 'connect' ? {
        connectNamedPipe: vi.fn(async () => { stopped = true; return 'connected' as const }),
      } : {})
      const serve = vi.fn(async () => 'unreachable')
      await expect(withCancellableAcceptedWindowsNamedPipe({
        policy, bindings: fixture.native, stopRequested: () => stopped,
        attest: async () => { if (stopAt === 'attest') stopped = true; return { pid: 42 } }, serve,
      })).resolves.toEqual({ state: 'stopped' })
      expect(serve).not.toHaveBeenCalled()
    }
  })

  it('normalizes only object-shaped cancellation errors', async () => {
    let stopped = false
    const fixture = bindings({
      connectNamedPipe: vi.fn(async () => { stopped = true; throw 'cancelled' }),
    })
    await expect(withCancellableAcceptedWindowsNamedPipe({
      policy, bindings: fixture.native, stopRequested: () => stopped,
      attest: async () => ({ pid: 42 }), serve: async () => 'unreachable',
    })).rejects.toBeInstanceOf(HostAuthorityError)
  })

  it('normalizes a cancelled blocking connect only after stop is visible', async () => {
    let stopped = false
    const fixture = bindings({
      connectNamedPipe: vi.fn(async () => {
        stopped = true
        throw new WindowsNamedPipeNativeError('ConnectNamedPipe', 995)
      }),
    })
    await expect(withCancellableAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      stopRequested: () => stopped,
      attest: async () => ({ pid: 42 }),
      serve: async () => 'unreachable',
    })).resolves.toEqual({ state: 'stopped' })
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(91n)
    expect(fixture.native.disconnectNamedPipe).not.toHaveBeenCalled()
  })

  it('does not normalize cancellation-shaped errors from non-blocking APIs', async () => {
    let stopped = false
    const fixture = bindings()
    await expect(withCancellableAcceptedWindowsNamedPipe({
      policy,
      bindings: fixture.native,
      stopRequested: () => stopped,
      attest: async () => {
        stopped = true
        throw new WindowsNamedPipeNativeError('QueryFullProcessImageNameW', 995)
      },
      serve: async () => 'unreachable',
    })).rejects.toBeInstanceOf(HostAuthorityError)
    expect(fixture.native.disconnectNamedPipe).toHaveBeenCalledWith(91n)
    expect(fixture.native.closeHandle).toHaveBeenCalledWith(91n)
  })

  it('does not hide real connect or cleanup failures merely because stop is visible', async () => {
    for (const failure of [
      { win32Code: 5, cleanupFails: false },
      { win32Code: 995, cleanupFails: true },
    ]) {
      let stopped = false
      const overrides = {
        connectNamedPipe: vi.fn(async () => {
          stopped = true
          throw new WindowsNamedPipeNativeError('ConnectNamedPipe', failure.win32Code)
        }),
        ...(failure.cleanupFails
          ? { closeHandle: vi.fn(() => { throw new Error('CloseHandle failed') }) }
          : {}),
      }
      const fixture = bindings(overrides)
      await expect(withCancellableAcceptedWindowsNamedPipe({
        policy,
        bindings: fixture.native,
        stopRequested: () => stopped,
        attest: async () => ({ pid: 42 }),
        serve: async () => 'unreachable',
      })).rejects.toBeInstanceOf(HostAuthorityError)
    }
  })
})
