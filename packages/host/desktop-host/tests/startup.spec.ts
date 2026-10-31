import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startDesktopHostApplication, type Config } from '../src/startup.ts'

function accountKeyring(root: string): { path: string; sha256: string } {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const raw = `${JSON.stringify({
    version: 2,
    issuer: 'https://accounts.dsh.colorbuyai.com',
    keys: [{ kid: 'test-key', publicJwk: keys.publicKey.export({ format: 'jwk' }) }],
  })}\n`
  const path = join(root, 'account-keyring.json')
  writeFileSync(path, raw, { mode: 0o600 })
  return { path, sha256: createHash('sha256').update(raw).digest('hex') }
}

describe.runIf(process.platform === 'darwin')('desktop Host application composition', () => {
  it('starts the supported owner app, refuses a second instance, and reaches quiescence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-app-'))
    const deviceKey = join(root, 'device-index.key')
    const privateKey = join(root, 'installation-private.pem')
    const legacyDshRoot = join(root, 'legacy-dsh')
    mkdirSync(legacyDshRoot, { mode: 0o755 })
    chmodSync(legacyDshRoot, 0o755)
    const keys = generateKeyPairSync('ed25519')
    writeFileSync(deviceKey, Buffer.alloc(32, 7), { mode: 0o600 })
    writeFileSync(privateKey, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    const accountKeys = accountKeyring(root)
    const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
    const config: Config = {
      root, registrationRoot: join(legacyDshRoot, 'host'), nodeExecutablePath: privateKey,
      dshEntrypointPath: privateKey, deviceIndexKeyPath: deviceKey,
      accountKeyringPath: accountKeys.path, accountKeyringSha256: accountKeys.sha256,
      installationPrivateKeyPath: privateKey, installationPublicKey: publicKey,
      installationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121',
      endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
      hostInstanceId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120',
      processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
      executableSignatureDigest: '1'.repeat(64), desktopTeamIdentifiers: ['TEAM123'],
      desktopExecutableDigests: ['2'.repeat(64)], runtimeGeneration: 1, schemaGeneration: 1,
    }
    const app = await startDesktopHostApplication(config)
    expect(existsSync(join(root, 'host.sock'))).toBe(true)
    expect(JSON.parse(readFileSync(join(legacyDshRoot, 'host', 'registration.v1.json'), 'utf8'))).toEqual({
      schema_version: 1,
      endpoint_registration_id: config.endpointRegistrationId,
      socket_path: join(root, 'host.sock'),
      installation_id: config.installationId,
      installation_public_key: config.installationPublicKey,
      executable_signature_digest: config.executableSignatureDigest,
    })
    await expect(startDesktopHostApplication(config)).rejects.toMatchObject({ code: 'conflict' })
    await app.close()
    expect(existsSync(join(root, 'host.sock'))).toBe(false)
    expect(existsSync(join(root, 'host.lock'))).toBe(false)
    const registration = join(legacyDshRoot, 'host', 'registration.v1.json')
    const restarted = await startDesktopHostApplication(config)
    await restarted.close()
    writeFileSync(registration, `${JSON.stringify({
      schema_version: 1, endpoint_registration_id: config.endpointRegistrationId,
      socket_path: join(root, 'host.sock'), installation_id: config.installationId,
      installation_public_key: config.installationPublicKey,
      executable_signature_digest: '3'.repeat(64),
    })}\n`, { mode: 0o600 })
    const upgraded = await startDesktopHostApplication(config)
    expect(JSON.parse(readFileSync(registration, 'utf8'))).toMatchObject({
      executable_signature_digest: config.executableSignatureDigest,
    })
    await upgraded.close()
    const externalInstallationId = '018f0f4c-87f8-7e2d-a2f8-7b93d34e3199'
    writeFileSync(registration, `${JSON.stringify({
      schema_version: 1, endpoint_registration_id: config.endpointRegistrationId,
      socket_path: join(root, 'host.sock'), installation_id: externalInstallationId,
      installation_public_key: config.installationPublicKey,
      executable_signature_digest: config.executableSignatureDigest,
    })}\n`, { mode: 0o600 })
    await expect(startDesktopHostApplication(config)).rejects.toMatchObject({ code: 'conflict' })
    expect(readFileSync(registration, 'utf8')).toContain(externalInstallationId)
    for (const invalidDigest of [7, 'z'.repeat(64)]) {
      writeFileSync(registration, `${JSON.stringify({
        schema_version: 1, endpoint_registration_id: config.endpointRegistrationId,
        socket_path: join(root, 'host.sock'), installation_id: config.installationId,
        installation_public_key: config.installationPublicKey,
        executable_signature_digest: invalidDigest,
      })}\n`, { mode: 0o600 })
      await expect(startDesktopHostApplication(config)).rejects.toMatchObject({ code: 'unavailable' })
    }
    unlinkSync(registration)
    symlinkSync(deviceKey, registration)
    await expect(startDesktopHostApplication(config)).rejects.toMatchObject({ code: 'unavailable' })
    expect(existsSync(join(root, 'host.sock'))).toBe(false)
  })

  it('rejects a symlink-substituted Host root before lock or socket creation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dsh-host-link-'))
    const target = mkdtempSync(join(tmpdir(), 'dsh-host-target-'))
    const root = join(parent, 'host')
    symlinkSync(target, root)
    const deviceKey = join(parent, 'device-index.key')
    const privateKey = join(parent, 'installation-private.pem')
    const keys = generateKeyPairSync('ed25519')
    writeFileSync(deviceKey, Buffer.alloc(32, 7), { mode: 0o600 })
    writeFileSync(privateKey, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    const accountKeys = accountKeyring(parent)
    const publicKey = (keys.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64url')
    const config: Config = {
      root, registrationRoot: join(parent, 'registration'), nodeExecutablePath: privateKey,
      dshEntrypointPath: privateKey, deviceIndexKeyPath: deviceKey,
      accountKeyringPath: accountKeys.path, accountKeyringSha256: accountKeys.sha256,
      installationPrivateKeyPath: privateKey, installationPublicKey: publicKey,
      installationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3121',
      endpointRegistrationId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3122',
      hostInstanceId: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120',
      processNonce: 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8',
      executableSignatureDigest: '1'.repeat(64), desktopTeamIdentifiers: ['TEAM123'],
      desktopExecutableDigests: ['2'.repeat(64)], runtimeGeneration: 1, schemaGeneration: 1,
    }
    await expect(startDesktopHostApplication(config)).rejects.toMatchObject({ code: 'unavailable' })
    expect(existsSync(join(target, 'host.lock'))).toBe(false)
  })
})
