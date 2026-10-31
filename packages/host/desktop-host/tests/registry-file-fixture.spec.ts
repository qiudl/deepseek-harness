import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ProfileRegistry } from '../src/profile-registry.ts'
import { registryFileFixture } from './registry-file-fixture.ts'

it('keeps independent protocol registries isolated across restart and rollback', async () => {
  const firstOptions = { root: randomUUID(), deviceIndexKey: Buffer.alloc(32, 7),
    clock: { now: () => 1000 }, ...registryFileFixture() }
  const secondOptions = { ...firstOptions, ...registryFileFixture() }
  const first = new ProfileRegistry(firstOptions)
  const second = new ProfileRegistry(secondOptions)
  const input = { keyHandle: 'fixture:local', unlockMaterial: Buffer.alloc(32, 9).toString('base64url') }
  const firstProfile = await first.createLocalAnonymous(input)
  const secondProfile = await second.createLocalAnonymous(input)
  expect(new ProfileRegistry(firstOptions).resolveProfile(firstProfile.profileId)).toEqual(firstProfile)
  expect(new ProfileRegistry(secondOptions).resolveProfile(firstProfile.profileId)).toBeNull()
  first.rollbackRegistration(firstProfile.profileId)
  expect(new ProfileRegistry(firstOptions).resolveProfile(firstProfile.profileId)).toBeNull()
  expect(new ProfileRegistry(secondOptions).resolveProfile(secondProfile.profileId)).toEqual(secondProfile)
})
