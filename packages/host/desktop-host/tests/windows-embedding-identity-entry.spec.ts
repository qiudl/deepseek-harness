import { afterEach, describe, expect, it, vi } from 'vitest'

const validEnvironment = {
  DSH_HOST_STORAGE_ROOT: String.raw`C:\Users\alice\AppData\Local\Slark\DSH`,
  DSH_HOST_ROOT: String.raw`C:\Users\alice\AppData\Local\Slark\DSH\environments\production`,
  DSH_HOST_ACCOUNT_KEYRING_SHA256: 'a'.repeat(64),
  DSH_HOST_RUNTIME_GENERATION: '1',
  DSH_HOST_SCHEMA_GENERATION: '1',
  DSH_HOST_VAULT_NATIVE_MODULE_PATH: String.raw`C:\Program Files\Slark\resources\vault.node`,
  DSH_HOST_VAULT_NATIVE_MODULE_SHA256: 'b'.repeat(64),
}

async function runEntry(options: {
  readonly reads?: readonly Buffer[]
  readonly readFullBuffers?: boolean
  readonly environment?: Partial<Record<keyof typeof validEnvironment, string | undefined>>
  readonly prepareError?: Error
} = {}) {
  vi.resetModules()
  for (const [name, value] of Object.entries({ ...validEnvironment, ...options.environment })) {
    if (value === undefined) vi.stubEnv(name, undefined)
    else vi.stubEnv(name, value)
  }
  const reads = [...(options.reads ?? [Buffer.from('{"keys":[]}')])]
  const readSync = vi.fn((_fd: number, target: Buffer, offset: number, length: number) => {
    if (options.readFullBuffers) return length
    const next = reads.shift()
    if (next === undefined) return 0
    next.copy(target, offset)
    return next.length
  })
  const identity = { installationId: 'installation', endpointRegistrationId: 'endpoint' }
  const prepare = vi.fn(async () => {
    if (options.prepareError !== undefined) throw options.prepareError
    return identity
  })
  vi.doMock('node:fs', () => ({ readSync }))
  vi.doMock('../src/windows-embedding-identity.ts', () => ({
    prepareWindowsDesktopHostEmbeddingIdentity: prepare,
  }))
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  process.exitCode = undefined
  await import('../src/windows-embedding-identity-entry.ts')
  await vi.waitFor(() => {
    expect(write.mock.calls.length > 0 || process.exitCode === 1).toBe(true)
  })
  return { identity, prepare, readSync, write }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
})

describe('Windows embedding identity entry', { concurrent: false }, () => {
  it('reads stdin to EOF, validates bootstrap input, and emits one identity', async () => {
    const state = await runEntry({ reads: [Buffer.from('{"keys":'), Buffer.from('[]}')] })
    expect(state.prepare).toHaveBeenCalledWith({
      storageRoot: validEnvironment.DSH_HOST_STORAGE_ROOT,
      root: validEnvironment.DSH_HOST_ROOT,
      accountAccessKeyring: '{"keys":[]}',
      accountKeyringSha256: validEnvironment.DSH_HOST_ACCOUNT_KEYRING_SHA256,
      runtimeGeneration: 1,
      schemaGeneration: 1,
    }, {
      loadCurrentUserSid: expect.any(Function),
      loadRegistrationFileBindings: expect.any(Function),
    })
    expect(state.write).toHaveBeenCalledWith(`${JSON.stringify(state.identity)}\n`)
  })

  it('fails closed on empty, oversized, and malformed UTF-8 stdin', async () => {
    for (const input of [
      { reads: [] },
      { readFullBuffers: true },
      { reads: [Buffer.from([0xFF])] },
    ]) {
      const state = await runEntry(input)
      expect(process.exitCode).toBe(1)
      expect(state.prepare).not.toHaveBeenCalled()
    }
  })

  it('fails closed on absent or empty required environment values', async () => {
    for (const value of [undefined, '']) {
      const state = await runEntry({ environment: { DSH_HOST_ROOT: value } })
      expect(process.exitCode).toBe(1)
      expect(state.prepare).not.toHaveBeenCalled()
    }
  })

  it('fails closed on non-numeric, non-positive, and unsafe generations', async () => {
    for (const value of ['x', '0', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const state = await runEntry({ environment: { DSH_HOST_RUNTIME_GENERATION: value } })
      expect(process.exitCode).toBe(1)
      expect(state.prepare).not.toHaveBeenCalled()
    }
  })

  it('turns preparation failure into a process exit failure', async () => {
    const state = await runEntry({ prepareError: new Error('prepare failed') })
    expect(process.exitCode).toBe(1)
    expect(state.prepare).toHaveBeenCalledOnce()
    expect(state.write).not.toHaveBeenCalled()
  })
})
