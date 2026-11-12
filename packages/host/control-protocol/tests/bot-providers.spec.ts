import { describe, expect, it } from 'vitest'
import { parseHostBotProviders, parseHostBotProvidersRequest } from '../src/bot-providers.js'

const view = { available: true,
  providers: [{ id: 'deepseek', name: 'DeepSeek',
    models: [{ ref: 'deepseek/chat', name: 'Chat' }],
    key: { configured: true, writable: false }, removable: false, custom: false, hasError: false }],
  addable: [{ id: 'other', name: 'Other' }], protocols: ['openai-responses'] }

describe('native provider directory boundary', () => {
  it('keeps only the authenticated empty selector and credential-free state', () => {
    expect(parseHostBotProvidersRequest({})).toEqual({})
    expect(() => parseHostBotProvidersRequest({ profileId: 'other' })).toThrow()
    expect(parseHostBotProviders(view)).toEqual(view)
    expect(() => parseHostBotProviders({ ...view, providers: [{ ...view.providers[0],
      key: { ...view.providers[0]!.key, value: 'secret' } }] })).toThrow()
    expect(() => parseHostBotProviders({ ...view, providers: [...view.providers, view.providers[0]] })).toThrow()
  })

  it('accepts unavailable state but rejects forged or oversized fields', () => {
    expect(parseHostBotProviders({ available: false, providers: [], addable: [], protocols: [] }))
      .toEqual({ available: false, providers: [], addable: [], protocols: [] })
    expect(() => parseHostBotProviders({ ...view, secret: 'value' })).toThrow()
    expect(() => parseHostBotProviders({ ...view, providers: [{ ...view.providers[0],
      models: [{ ref: 'x'.repeat(513), name: 'Too long' }] }] })).toThrow()
  })
})
