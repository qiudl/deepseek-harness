import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { encodeHostFriendBotConfirmationPayload,
  parseHostFriendBotConfirmationAssertion,
  parseHostFriendBotConfirmationChallenge } from '../src/friend-bot-confirmation.ts'
import { friendBotChallengeFixture } from './friend-bot-confirmation-fixture.ts'

it('matches the independently captured Slark friend-only golden payload', () => {
  const c = parseHostFriendBotConfirmationChallenge(friendBotChallengeFixture())
  expect(Object.isFrozen(c)).toBe(true)
  expect(c).toEqual(friendBotChallengeFixture())
  expect(createHash('sha256').update(encodeHostFriendBotConfirmationPayload(c)).digest('hex'))
    .toBe('43164e2e9fe28de67e0980428dde494e4a40f845eae31094c78f383311c77862')
})

it('rejects unknown fields, stale span and objects before string coercion', () => {
  const c = friendBotChallengeFixture()
  for (const change of [{ extra: true }, { expires_at: c.issued_at+10_001 },
    { bot_epoch: '01' }, { host_public_key: 'invalid' }, { role: 'peer' }])
    expect(() => parseHostFriendBotConfirmationChallenge({ ...c, ...change })).toThrow()
  let called = false
  expect(() => parseHostFriendBotConfirmationChallenge({ ...c,
    bot_id: { toString() { called = true; return c.bot_id } } })).toThrow()
  expect(called).toBe(false)
})

it('rejects malformed challenge coordinates and non-canonical encodings', () => {
  const c = friendBotChallengeFixture()
  for (const invalid of [null, [], Object.create(null), { ...c, extra: 1 },
    { ...c, bot_id: undefined }, { ...c, issued_at: -1 },
    { ...c, nonce: 'invalid=' }, { ...c, account_issuer: 1 },
    { ...c, invite_version: '9223372036854775808' },
    { ...c, computer_installation_id: 'x'.repeat(129) },
    { ...c, bot_id: 'invalid bot' },
    { ...c, host_public_key: 'a'.repeat(43) },
    { ...c, nonce: 'A'.repeat(42)+'B' },
    { ...c, account_issuer: 'x'.repeat(2049) },
    { ...c, account_issuer: 'http://example.com' },
    { ...c, account_issuer: 'https://example.com/path' },
    { ...c, account_issuer: 'not-a-url' }])
    expect(() => parseHostFriendBotConfirmationChallenge(invalid)).toThrow()
  const accessor = Object.defineProperty({ ...c }, 'bot_id', { get: () => 'session-bot-a' })
  expect(() => parseHostFriendBotConfirmationChallenge(accessor)).toThrow()
  const hidden = Object.defineProperty({ ...c }, 'bot_id', { value: c.bot_id, enumerable: false })
  expect(() => parseHostFriendBotConfirmationChallenge(hidden)).toThrow()
  const missing = { ...c, alternate: c.bot_id }
  delete (missing as { bot_id?: string }).bot_id
  expect(() => parseHostFriendBotConfirmationChallenge(missing)).toThrow()
})

it('accepts only exact assertions with a canonical 64-byte signature', () => {
  const c = friendBotChallengeFixture()
  const signature = Buffer.alloc(64, 7).toString('base64url')
  const assertion = parseHostFriendBotConfirmationAssertion({ schema_version: 1, challenge: c, signature })
  expect(Object.isFrozen(assertion)).toBe(true)
  for (const invalid of [{ ...assertion, extra: true }, { ...assertion, schema_version: 2 },
    { ...assertion, signature: 'bad' }])
    expect(() => parseHostFriendBotConfirmationAssertion(invalid)).toThrow()
})
