/** Public embedding only: parser tests mint no Account, runtime or coordination authority. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { it } from 'vitest'
import {
  parseHostTaskCoordinationEnvironment,
  parseHostTaskCoordinationEnvironments,
  type HostTaskCoordinationEnvironment,
} from '../src/task-coordination-environment.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/task-coordination-v1.json', import.meta.url), 'utf8')) as {
  environments: [HostTaskCoordinationEnvironment]
}
const original = fixture.environments[0]
it('accepts the existing public keyring DTO only under the explicit task-control audience', () => {
  const parsed = parseHostTaskCoordinationEnvironment(original)
  assert.deepEqual(parsed, original)
  assert.notEqual(parsed.keyring, original.keyring)
  assert(Object.isFrozen(parsed) && Object.isFrozen(parsed.keyring) && Object.isFrozen(parsed.keyring.keys))
  assert(Object.isFrozen(parsed.keyring.keys[0]))
})
it('rejects memory/device/unknown purpose policies and ambient URL environment selectors', () => {
  for (const audience of ['urn:slark:project-memory:v1', 'urn:slark:device-task:v1', 'unknown'])
    assert.throws(() => parseHostTaskCoordinationEnvironment({ ...original, audience }))
  for (const environmentKey of ['https://cloud.example.test', '', '../staging', 'x'.repeat(129)])
    assert.throws(() => parseHostTaskCoordinationEnvironment({ ...original, environmentKey }))
  assert.throws(() => parseHostTaskCoordinationEnvironment({ ...original, extra: true }))
})
it('rejects private keys, duplicate or missing keys, invalid intervals and non-Ed25519 material', () => {
  const key = original.keyring.keys[0]!,
    ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const keys = [
    [],
    [key, key],
    [{ ...key, privateKeyPem: 'forbidden' }],
    [{ ...key, publicKeyPem: 'PRIVATE KEY' }],
    [{ ...key, publicKeyPem: 'invalid' }],
    [{ ...key, publicKeyPem: ec.publicKey.export({ format: 'pem', type: 'spki' }).toString() }],
    [{ ...key, validFrom: 0 }],
    [{ ...key, validUntil: key.validFrom }],
    [{ ...key, kid: 'other-domain' }],
  ]
  for (const candidate of keys)
    assert.throws(() =>
      parseHostTaskCoordinationEnvironment({ ...original, keyring: { ...original.keyring, keys: candidate } }),
    )
  assert.throws(() =>
    parseHostTaskCoordinationEnvironment({ ...original, keyring: { ...original.keyring, version: 2 } }),
  )
})
it('guards keyring and key-list descriptors before reusing the public keyring parser', () => {
  let reads = 0
  const candidate = { ...original, keyring: { ...original.keyring, keys: [...original.keyring.keys] } }
  Object.defineProperty(candidate.keyring.keys, '0', {
    enumerable: true,
    get: () => {
      reads++
      return original.keyring.keys[0]
    },
  })
  assert.throws(() => parseHostTaskCoordinationEnvironment(candidate))
  assert.equal(reads, 0)
  const outer = { ...original }
  Object.defineProperty(outer, 'keyring', {
    enumerable: true,
    get: () => {
      reads++
      return original.keyring
    },
  })
  assert.throws(() => parseHostTaskCoordinationEnvironment(outer))
  assert.equal(reads, 0)
  assert.throws(() =>
    parseHostTaskCoordinationEnvironment({ ...original, keyring: { ...original.keyring, extra: null } }),
  )
})

it('bounds explicit worker JSON to four unique environments and exactly 64KiB', () => {
  assert.deepEqual(parseHostTaskCoordinationEnvironments(undefined), [])
  assert.deepEqual(parseHostTaskCoordinationEnvironments('[]'), [])
  const raw = JSON.stringify([original])
  assert.deepEqual(parseHostTaskCoordinationEnvironments(raw), [original])
  assert.deepEqual(parseHostTaskCoordinationEnvironments(' '.repeat(65536 - Buffer.byteLength(raw)) + raw), [original])
  const four = Array.from({ length: 4 }, (_, i) => ({
    ...original,
    keyring: { ...original.keyring, environmentId: 'ffffffff-1111-4111-8111-' + String(i).padStart(12, '0') },
  }))
  assert.equal(parseHostTaskCoordinationEnvironments(JSON.stringify(four)).length, 4)
  for (const value of [
    '{',
    '{}',
    ' '.repeat(65537),
    JSON.stringify([original, original]),
    JSON.stringify([...four, original]),
  ])
    assert.throws(() => parseHostTaskCoordinationEnvironments(value))
})
