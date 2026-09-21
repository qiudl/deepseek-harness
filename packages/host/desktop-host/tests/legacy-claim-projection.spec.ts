import { describe, expect, it } from 'vitest'
import { projectLegacyModelClaim } from '../src/legacy-claim-projection.ts'

const profileId = 'b9e8b0aa-5c8e-4d4c-8e7a-139a86985f41'
const operationId = '97086a03-9508-41c0-bec3-7464dc835953'
const sourceSettings = {
  'llm-deepseek': { apiKeyEnv: 'SHARED_KEY', baseURL: 'https://api.deepseek.com' },
  'llm-pi-ai': { providers: {
    custom: { apiKeyEnv: 'SHARED_KEY', api: 'openai-completions', baseURL: 'https://example.com' },
    other: { apiKeyEnv: 'OTHER_KEY', api: 'openai-completions' },
  } },
  'web-search-deepseek': { apiKeyEnv: 'SHARED_KEY', model: 'search-model' },
  'agent-default-model': { provider: 'custom', model: 'legacy-default' },
  permission: { mode: 'unsafe' },
}
const sourceCredentials = { refs: { SHARED_KEY: 'secret-shared', OTHER_KEY: 'secret-other' }, records: {
  'llm-pi-ai/custom': { kind: 'grant', payload: { token: 'legacy-grant' } },
} }
const targetSettings = { 'llm-pi-ai': { providers: { personal: { apiKeyEnv: 'PERSONAL_KEY' } } }, ui: { theme: 'dark' } }
const targetCredentials = { refs: { PERSONAL_KEY: 'personal-secret' }, records: {
  'llm-pi-ai/personal': { kind: 'api-key', key: 'personal-record' },
} }

function project(candidateId: string, overrides: Record<string, unknown> = {}) {
  return projectLegacyModelClaim({
    candidateId, profileId, operationId, sourceSettings, sourceCredentials,
    targetSettings, targetCredentials, ...overrides,
  })
}

describe('one-provider legacy model claim projection', () => {
  it('copies only the DeepSeek route and remaps its shared secret', () => {
    const result = project('llm-deepseek:deepseek')
    expect(result.reference).toMatch(/^DSH_CLAIM_[A-F0-9]{32}$/u)
    expect(result.settings).toEqual({
      ...targetSettings,
      'llm-deepseek': { apiKeyEnv: result.reference, baseURL: 'https://api.deepseek.com' },
    })
    expect(result.credentials).toEqual({
      refs: { ...targetCredentials.refs, [result.reference]: 'secret-shared' },
      records: targetCredentials.records,
    })
    expect(result.settings).not.toHaveProperty('agent-default-model')
    expect(result.settings).not.toHaveProperty('web-search-deepseek')
    expect(sourceSettings['llm-deepseek'].apiKeyEnv).toBe('SHARED_KEY')
    expect(targetSettings).not.toHaveProperty('llm-deepseek')
    expect(project('llm-deepseek:deepseek').reference).toBe(result.reference)
    expect(project('llm-deepseek:deepseek', {
      targetSettings: result.settings, targetCredentials: result.credentials,
    })).toEqual(result)
  })

  it('copies only the chosen pi-ai provider and leaves another route disabled', () => {
    const result = project('llm-pi-ai:custom')
    expect(result.settings['llm-pi-ai']).toEqual({ providers: {
      personal: { apiKeyEnv: 'PERSONAL_KEY' },
      custom: { apiKeyEnv: result.reference, api: 'openai-completions', baseURL: 'https://example.com' },
    } })
    expect(JSON.stringify(result.settings)).not.toContain('OTHER_KEY')
    expect(JSON.stringify(result.credentials)).not.toContain('legacy-grant')
    const other = project('llm-pi-ai:other')
    expect(other.reference).not.toBe(result.reference)
    expect(other.credentials.refs[other.reference]).toBe('secret-other')
    expect(project('llm-pi-ai:custom', { targetSettings: result.settings, targetCredentials: result.credentials }))
      .toEqual(result)
  })

  it('moves a literal web-search key into a private credential reference', () => {
    const result = project('web-search-deepseek:deepseek', {
      sourceSettings: {
        ...sourceSettings, 'web-search-deepseek': { apiKey: 'literal-secret', model: 'search-model' },
      },
      sourceCredentials: { refs: {}, records: {} },
    })
    expect(result.settings['web-search-deepseek']).toEqual({ apiKeyEnv: result.reference, model: 'search-model' })
    expect(result.credentials.refs[result.reference]).toBe('literal-secret')
    expect(JSON.stringify(result.settings)).not.toContain('literal-secret')
    const referenced = project('web-search-deepseek:deepseek')
    expect(referenced.credentials.refs[referenced.reference]).toBe('secret-shared')
  })

  it('uses the declared default DeepSeek ref and creates a missing pi-ai target section', () => {
    const sourceCredentials = { refs: { DEEPSEEK_API_KEY: 'default-secret', SHARED_KEY: 'pi-secret' }, records: {} }
    const deepseek = project('llm-deepseek:deepseek', {
      sourceSettings: { 'llm-pi-ai': sourceSettings['llm-pi-ai'] }, sourceCredentials,
    })
    expect(deepseek.settings['llm-deepseek']).toEqual({ apiKeyEnv: deepseek.reference })
    expect(deepseek.credentials.refs[deepseek.reference]).toBe('default-secret')
    const explicit = project('llm-deepseek:deepseek', {
      sourceSettings: { 'llm-deepseek': {} }, sourceCredentials,
    })
    expect(explicit.settings['llm-deepseek']).toEqual({ apiKeyEnv: explicit.reference })
    const pi = project('llm-pi-ai:custom', { targetSettings: {} })
    expect(pi.settings['llm-pi-ai']).toEqual({ providers: { custom: {
      apiKeyEnv: pi.reference, api: 'openai-completions', baseURL: 'https://example.com',
    } } })
    const emptyProviders = project('llm-pi-ai:custom', { targetSettings: { 'llm-pi-ai': {} } })
    expect(emptyProviders.settings['llm-pi-ai']).toEqual(pi.settings['llm-pi-ai'])
  })

  it('refuses missing credentials and unsupported candidates', () => {
    expect(() => project('llm-deepseek:deepseek', { sourceCredentials: { refs: {}, records: {} } }))
      .toThrow(/conflict/u)
    expect(() => project('llm-pi-ai:custom', { sourceSettings: {
      ...sourceSettings, 'llm-pi-ai': { providers: { custom: { api: 'openai-completions' } } },
    } })).toThrow(/conflict/u)
    expect(() => project('llm-pi-ai:BAD')).toThrow(/invalid_input/u)
    expect(() => project('unknown:provider')).toThrow(/invalid_input/u)
    expect(() => project('llm-deepseek:deepseek', { sourceSettings: {
      'llm-deepseek': { apiKeyEnv: 'toString' },
    }, sourceCredentials: { refs: {}, records: {} } })).toThrow(/conflict/u)
    expect(() => project('web-search-deepseek:deepseek', { sourceSettings: {
      ...sourceSettings, 'web-search-deepseek': {},
    } })).toThrow(/conflict/u)
    for (const field of ['apiKey', 'token', 'password', 'secret', 'authorization', 'headers']) {
      expect(() => project('llm-deepseek:deepseek', { sourceSettings: {
        'llm-deepseek': { apiKeyEnv: 'SHARED_KEY', [field]: 'embedded-secret' },
      } })).toThrow(/invalid_input/u)
      expect(() => project('llm-pi-ai:custom', { sourceSettings: {
        'llm-pi-ai': { providers: { custom: { apiKeyEnv: 'SHARED_KEY', [field]: 'embedded-secret' } } },
      } })).toThrow(/invalid_input/u)
    }
  })

  it('preserves personal edits and refuses collisions', () => {
    expect(() => project('llm-deepseek:deepseek', { targetSettings: {
      ...targetSettings, 'llm-deepseek': { apiKeyEnv: 'PERSONAL_KEY' },
    } })).toThrow(/conflict/u)
    expect(() => project('llm-pi-ai:custom', { targetSettings: {
      'llm-pi-ai': { providers: { custom: { apiKeyEnv: 'PERSONAL_KEY' } } },
    } })).toThrow(/conflict/u)
    const constructorRoute = project('llm-pi-ai:constructor', { sourceSettings: {
      'llm-pi-ai': { providers: { constructor: { apiKeyEnv: 'SHARED_KEY' } } },
    }, targetSettings: {} })
    expect(constructorRoute.settings['llm-pi-ai']).toEqual({ providers: {
      constructor: { apiKeyEnv: constructorRoute.reference },
    } })
    const reference = project('llm-deepseek:deepseek').reference
    expect(() => project('llm-deepseek:deepseek', { targetCredentials: {
      refs: { [reference]: 'different-secret' }, records: {},
    } })).toThrow(/conflict/u)
  })

  it('rejects malformed target and source documents', () => {
    for (const change of [
      { profileId: 'bad' }, { operationId: 'bad' }, { sourceSettings: [] },
      { sourceSettings: undefined }, { sourceCredentials: { refs: {}, records: {}, extra: true } },
      { sourceCredentials: { refs: { 'BAD-REF': 'secret' }, records: {} } },
      { sourceCredentials: { refs: { VALID: '' }, records: {} } },
      { sourceCredentials: { refs: {}, records: [] } }, { targetSettings: null },
      { targetCredentials: { refs: {}, records: null } },
    ]) expect(() => project('llm-deepseek:deepseek', change)).toThrow(/invalid_input/u)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => project('llm-deepseek:deepseek', { targetSettings: cycle })).toThrow(/invalid_input/u)
    expect(() => project('llm-pi-ai:custom', { sourceSettings: {
      ...sourceSettings, 'llm-pi-ai': { providers: null },
    } })).toThrow(/invalid_input/u)
    expect(() => project('llm-pi-ai:custom', { targetSettings: {
      'llm-pi-ai': { providers: null },
    } })).toThrow(/invalid_input/u)
  })
})
