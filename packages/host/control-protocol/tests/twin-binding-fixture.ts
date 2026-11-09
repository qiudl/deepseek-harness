/** Typed independent Python corpus; wire validation remains the production parser's responsibility. */
import { readFileSync } from 'node:fs'
import type { HostTwinBindingAck, HostTwinBindingDirective } from '../src/twin-binding.ts'
import type { HostTwinBindingOffer } from '../src/twin-binding-offer.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] }
type ScopeArray = [string, string, string, string, string, string,
  [string, string, string | null, string | null, string, string],
  unknown[], unknown[][], unknown[][], number, number, string, string[], unknown[]]
type OfferArray = [string, string, string, string, [[string, unknown[]], [string, unknown[]]]]
export type TwinBindingFixture = {
  ownerUserId: string
  authorityEnvironmentId: string
  requestId: string
  offer: Mutable<HostTwinBindingOffer>
  directive: Mutable<HostTwinBindingDirective>
  ack: Mutable<HostTwinBindingAck>
  expected: {
    dsh_to_slark: { scopeArray: ScopeArray }
    slark_to_dsh: { scopeArray: ScopeArray }
    offerArray: OfferArray
    offerDigest: string
    commandDigest: string
    directivePayload: string
    ackPayload: string
    ackDigest: string
  }
}
export function twinBindingFixture(): TwinBindingFixture {
  return JSON.parse(readFileSync(new URL('./fixtures/twin-binding-offer-v1.json', import.meta.url), 'utf8')) as TwinBindingFixture
}
/** Deliberately corrupt one raw input without weakening production DTO types. */
export function replaceFixtureValue<T>(source: T, path: readonly (string | number)[], value: unknown): T {
  const result = structuredClone(source)
  let parent: unknown = result
  for (const key of path.slice(0, -1)) parent = typeof key === 'number'
    ? (parent as unknown[])[key] : (parent as Record<string, unknown>)[key]
  const key = path.at(-1)
  if (key === undefined) throw Error('missing fixture path')
  if (typeof key === 'number') (parent as unknown[])[key] = value
  else (parent as Record<string, unknown>)[key] = value
  return result
}
