import { createHash } from 'node:crypto'
import { HostAuthorityError } from './types.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/u
const PROVIDER = /^[a-z][a-z0-9-]{0,63}$/u
const PI_PREFIX = 'llm-pi-ai:'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostAuthorityError('invalid_input')
  return value as Record<string, unknown>
}

function clone(value: unknown): unknown {
  let encoded: unknown
  try { encoded = JSON.stringify(value) } catch { throw new HostAuthorityError('invalid_input') }
  if (typeof encoded !== 'string') throw new HostAuthorityError('invalid_input')
  return JSON.parse(encoded) as unknown
}

function credentialDocument(value: unknown): {
  refs: Record<string, string>
  records: Record<string, unknown>
} {
  const source = record(value)
  const keys = Object.keys(source).sort().join(',')
  if (keys !== 'records,refs') throw new HostAuthorityError('invalid_input')
  const refs = record(source.refs)
  const records = record(source.records)
  if (Object.entries(refs).some(([name, secret]) => !REF.test(name) || typeof secret !== 'string' || !secret)) {
    throw new HostAuthorityError('invalid_input')
  }
  return { refs: refs as Record<string, string>, records }
}

function sourceRef(ref: unknown, refs: Record<string, string>): string {
  if (typeof ref !== 'string' || !REF.test(ref) || !Object.hasOwn(refs, ref) || !refs[ref]) {
    throw new HostAuthorityError('conflict')
  }
  return refs[ref]
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }

function rejectEmbeddedKey(route: Record<string, unknown>): void {
  if (Object.hasOwn(route, 'apiKey') || Object.hasOwn(route, 'token')
    || Object.hasOwn(route, 'password') || Object.hasOwn(route, 'secret')
    || Object.hasOwn(route, 'authorization') || Object.hasOwn(route, 'headers')) {
    throw new HostAuthorityError('invalid_input')
  }
}

export interface LegacyClaimProjection {
  readonly settings: Record<string, unknown>
  readonly credentials: { readonly refs: Record<string, string>; readonly records: Record<string, unknown> }
  readonly reference: string
}

/** Internal owner-only projection. The caller must bind the source digest and hold the Profile write fence. */
export function projectLegacyModelClaim(input: {
  readonly candidateId: string
  readonly profileId: string
  readonly operationId: string
  readonly sourceSettings: unknown
  /** Normalized `{ refs, records }` from the validated legacy reader. */
  readonly sourceCredentials: unknown
  readonly targetSettings: unknown
  readonly targetCredentials: unknown
}): LegacyClaimProjection {
  if (!UUID.test(input.profileId) || !UUID.test(input.operationId)) throw new HostAuthorityError('invalid_input')
  const sourceSettings = record(clone(input.sourceSettings))
  const sourceCredentials = credentialDocument(clone(input.sourceCredentials))
  const targetSettings = record(clone(input.targetSettings))
  const targetCredentials = credentialDocument(clone(input.targetCredentials))
  const reference = `DSH_CLAIM_${createHash('sha256')
    .update(`${input.profileId}\0${input.candidateId}\0${input.operationId}`).digest('hex').slice(0, 32).toUpperCase()}`
  let section: string
  let setting: Record<string, unknown>
  let secret: string
  if (input.candidateId === 'llm-deepseek:deepseek') {
    section = 'llm-deepseek'
    const original = record(sourceSettings[section] ?? {})
    rejectEmbeddedKey(original)
    secret = sourceRef(original.apiKeyEnv ?? 'DEEPSEEK_API_KEY', sourceCredentials.refs)
    setting = { ...original, apiKeyEnv: reference }
  } else if (input.candidateId.startsWith(PI_PREFIX)) {
    section = 'llm-pi-ai'
    const provider = input.candidateId.slice(PI_PREFIX.length)
    if (!PROVIDER.test(provider)) throw new HostAuthorityError('invalid_input')
    const sourceSection = record(sourceSettings[section])
    const sourceProviders = record(sourceSection.providers)
    const original = record(sourceProviders[provider])
    rejectEmbeddedKey(original)
    secret = sourceRef(original.apiKeyEnv, sourceCredentials.refs)
    const targetSection = record(targetSettings[section] ?? {})
    const targetProviders = record(targetSection.providers === undefined ? {} : targetSection.providers)
    const projected = { ...original, apiKeyEnv: reference }
    if (Object.hasOwn(targetProviders, provider) && !same(targetProviders[provider], projected)) {
      throw new HostAuthorityError('conflict')
    }
    setting = { ...targetSection, providers: { ...targetProviders, [provider]: projected } }
  } else if (input.candidateId === 'web-search-deepseek:deepseek') {
    section = 'web-search-deepseek'
    const original = record(sourceSettings[section])
    secret = typeof original.apiKey === 'string' && original.apiKey
      ? original.apiKey : sourceRef(original.apiKeyEnv ?? 'DEEPSEEK_API_KEY', sourceCredentials.refs)
    const { apiKey: _literal, ...withoutLiteral } = original
    setting = { ...withoutLiteral, apiKeyEnv: reference }
  } else throw new HostAuthorityError('invalid_input')
  if (section !== 'llm-pi-ai' && targetSettings[section] !== undefined && !same(targetSettings[section], setting)) {
    throw new HostAuthorityError('conflict')
  }
  const existing = targetCredentials.refs[reference]
  if (existing !== undefined && existing !== secret) throw new HostAuthorityError('conflict')
  return {
    settings: { ...targetSettings, [section]: setting },
    credentials: { refs: { ...targetCredentials.refs, [reference]: secret }, records: targetCredentials.records },
    reference,
  }
}
