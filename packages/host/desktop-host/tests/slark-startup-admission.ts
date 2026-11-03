import { createHash, randomUUID, sign, type KeyObject } from 'node:crypto'
import { expect } from 'vitest'
import type { DesktopHost } from '../src/desktop-host.ts'

/** Exercise the composed Host with a signed Slark credential and mismatching device. */
export async function expectSlarkStartupAdmission(host: DesktopHost, input: {
  key: KeyObject
  kid: string
  issuer: string
  subject: string
  deviceId: string
  now: number
}): Promise<void> {
  const expected = {
    slarkUserId: 'startup-user', environmentId: randomUUID(), profileId: randomUUID(),
    deviceId: input.deviceId, deviceKeyThumbprint: Buffer.alloc(32, 5).toString('base64url'),
    loginEpoch: 0, bindingEpoch: 1,
  }
  const bindingScope = createHash('sha256').update(JSON.stringify([
    'slark-dsh-binding-scope-v1', expected.environmentId, expected.slarkUserId,
  ])).digest('hex')
  const issuedAt = Math.floor(input.now / 1_000)
  const header = Buffer.from(JSON.stringify({
    alg: 'ES256', kid: input.kid, typ: 'dsh-slark-access+jwt',
  })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    ag: 1, aud: 'dsh-host', exp: issuedAt + 600, iat: issuedAt, iss: input.issuer,
    jti: randomUUID(), kg: 1, nbf: issuedAt, sg: 1, sid: randomUUID(), sub: input.subject,
    typ: 'dsh-slark-access+jwt', slark_user_id: expected.slarkUserId,
    environment_id: expected.environmentId, profile_id: expected.profileId,
    device_id: expected.deviceId, device_key_thumbprint: expected.deviceKeyThumbprint,
    binding_scope: bindingScope, login_epoch: 0, binding_epoch: 1, operation_id: randomUUID(),
  })).toString('base64url')
  const signingInput = `${header}.${payload}`
  const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: input.key, dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
  const authority = {
    issuer: input.issuer, subject: input.subject, authorityEnvironmentId: expected.environmentId,
    accountBindingHandle: `slark:${bindingScope}`, authorityBindingVersion: 1,
    accountAccessToken: `${signingInput}.${signature}`, expected,
    keyHandle: 'keychain:slark-startup', unlockMaterial: Buffer.alloc(32, 6).toString('base64url'),
    ownerId: 'slark-startup-owner',
  }
  const profile = await host.ensureSlarkAccountProfile(authority)
  expect(profile.bindingGeneration).toBe(1)
  expect(await host.ensureSlarkAccountProfile(authority)).toEqual(profile)
  await expect(host.ensureSlarkAccountProfile({ ...authority,
    expected: { ...expected, deviceId: randomUUID() },
  })).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(host.ensureAccountProfile(authority)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(host.getProfileStatus(authority)).toEqual({ state: 'ready', profileId: profile.profileId })
}
