import { twinBindingFixture, replaceFixtureValue } from './twin-binding-fixture.ts'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parseHostTwinBindingOffer, encodeHostTwinBindingOffer,
  hostTwinBindingOfferDigest, hostTwinBindingCommandDigest } from '../src/twin-binding-offer.ts'

const vector = twinBindingFixture()

it('matches independently generated complete bidirectional scope and command bytes', () => {
  const offer = parseHostTwinBindingOffer(vector.offer, vector)
  expect(offer).toEqual(vector.offer)
  expect(encodeHostTwinBindingOffer(offer)).toBe(JSON.stringify(vector.expected.offerArray))
  expect(hostTwinBindingOfferDigest(offer)).toBe(vector.expected.offerDigest)
  expect(hostTwinBindingCommandDigest(vector.requestId, offer)).toBe(vector.expected.commandDigest)
})

it('refuses forged retention, scope, owner, environment or direction instead of signing a digest', () => {
  const changes: Array<[readonly (string | number)[], unknown]> = [
    [['directions'], [...vector.offer.directions].reverse()],
    [['directions', 0, 'scope', 'historyTo'], vector.offer.directions[0].scope.historyTo + 1],
    [['directions', 0, 'scope', 'retentionConsentRef', 'consentDigest'], 'a'.repeat(64)],
    [['directions', 0, 'scope', 'sourceRef', 'hostProfileId'], null],
    [['directions', 1, 'scope', 'sourceRef', 'hostProfileId'], vector.offer.directions[0].scope.sourceRef.hostProfileId],
    [['directions', 0, 'scope', 'recipientRef', 'audienceRef'], 'other-owner'],
    [['secret'], 'private'],
  ]
  for (const [path, value] of changes) {
    const offer = replaceFixtureValue(vector.offer, path, value)
    expect(() => parseHostTwinBindingOffer(offer, vector)).toThrow('invalid_twin_binding_offer')
  }
  expect(() => parseHostTwinBindingOffer(vector.offer, { ...vector, ownerUserId: 'other' })).toThrow()
  expect(() => parseHostTwinBindingOffer(vector.offer, { ...vector,
    authorityEnvironmentId: '00000009-0000-4000-8000-000000000009' })).toThrow()
})

it('rejects caller accessors without executing them', () => {
  let read = false
  const offer = { ...vector.offer }
  Object.defineProperty(offer, 'directions', { get() { read = true; return [] } })
  expect(() => parseHostTwinBindingOffer(offer, vector)).toThrow()
  expect(read).toBe(false)
  expect(() => parseHostTwinBindingOffer(Object.create(vector.offer), vector)).toThrow()
})

it('refuses independently rehashed cross-Bot, cross-project and conflicting bidirectional selections', () => {
  const invalid = JSON.parse(readFileSync(new URL('./fixtures/twin-binding-offer-invalid-v1.json', import.meta.url), 'utf8')) as
    Array<{ name: string; offer: unknown }>
  for (const item of invalid)
    expect(() => parseHostTwinBindingOffer(item.offer, vector), item.name).toThrow('invalid_twin_binding_offer')
})

it('refuses unknown terms, invalid zones, paths, duplicate grants and accessor-bearing arrays', () => {
  const scope = vector.offer.directions[0].scope
  const changes: Array<[readonly (string | number)[], unknown]> = [
    [['presentationVersion'], 'unknown'],
    [['directions', 0, 'scope', 'retentionConsentRef', 'presentationVersion'], 'unknown'],
    [['directions', 0, 'scope', 'sourceRef', 'side'], 'other'],
    [['directions', 0, 'scope', 'projectId'], '.'],
    [['directions', 0, 'scope', 'timeZone'], 'Missing/Zone'],
    [['directions', 0, 'scope', 'deviceGrantRefs'], null],
    [['directions', 0, 'scope', 'deviceGrantRefs'], Array.from({ length: 11 }, () => scope.deviceGrantRefs[0])],
    [['directions', 0, 'scope', 'deviceGrantRefs'], [...scope.deviceGrantRefs, scope.deviceGrantRefs[0]]],
    [['directions', 0, 'scope', 'workspaceRefs'], [...scope.workspaceRefs, scope.workspaceRefs[0]]],
  ]
  for (const [path, value] of changes) {
    const offer = replaceFixtureValue(vector.offer, path, value)
    expect(() => parseHostTwinBindingOffer(offer, vector)).toThrow('invalid_twin_binding_offer')
  }
  const accessor = structuredClone(vector.offer)
  Object.defineProperty(accessor.directions[0].scope.deviceGrantRefs, '0', {
    enumerable: true, get() { throw Error('accessor_must_not_execute') },
  })
  expect(() => parseHostTwinBindingOffer(accessor, vector)).toThrow('invalid_twin_binding_offer')
})

it('orders workspace and grant coordinates by their actual ASCII values, including prefixes and quotes', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/twin-binding-workspace-order-v1.json', import.meta.url), 'utf8')) as
    Array<{ name: string; accepted: boolean; offer: unknown }>
  for (const item of cases) {
    if (item.accepted) expect(parseHostTwinBindingOffer(item.offer, vector), item.name).toEqual(item.offer)
    else expect(() => parseHostTwinBindingOffer(item.offer, vector), item.name).toThrow('invalid_twin_binding_offer')
  }
})
