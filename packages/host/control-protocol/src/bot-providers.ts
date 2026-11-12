/** Fixed native projection of configured model providers; credential values never appear. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

const bounded = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.length > 0 && Buffer.byteLength(value, 'utf8') <= max &&
  [...value].every((char) => { const code = char.codePointAt(0); return code !== undefined && code > 31 && code !== 127 })
const providerID = (value: unknown): value is string => bounded(value, 100) &&
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)
const protocolIDs = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

export type HostBotProvidersRequest = Readonly<Record<string, never>>
export type HostBotProviders = Readonly<{
  available: boolean
  providers: readonly Readonly<{
    id: string
    name: string
    models: readonly Readonly<{ ref: string; name: string }>[]
    key: Readonly<{ configured: boolean; writable: boolean }> | null
    removable: boolean
    custom: boolean
    hasError: boolean
  }>[]
  addable: readonly Readonly<{ id: string; name: string }>[]
  protocols: readonly string[]
}>

/** @param value Untrusted args. @returns Empty Profile-selected request. */
export function parseHostBotProvidersRequest(value: unknown): HostBotProvidersRequest {
  if (!record(value) || !exact(value, [])) throw Error('invalid_bot_providers_request')
  return {}
}

/** @param value Untrusted plugin result. @returns Exact credential-free directory. */
export function parseHostBotProviders(value: unknown): HostBotProviders | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['available', 'providers', 'addable', 'protocols']) ||
    typeof value.available !== 'boolean' || !Array.isArray(value.providers) || value.providers.length > 100 ||
    !Array.isArray(value.addable) || value.addable.length > 100 ||
    !Array.isArray(value.protocols) || value.protocols.length > 3 ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > 60_000) throw Error('invalid_bot_providers_result')
  const seen = new Set<string>()
  let modelCount = 0
  const providers = value.providers.map((entry: unknown) => {
    if (!record(entry) || !exact(entry, ['id', 'name', 'models', 'key', 'removable', 'custom', 'hasError']) ||
      !providerID(entry.id) || seen.has(entry.id) || !bounded(entry.name, 256) ||
      !Array.isArray(entry.models) || entry.models.length > 100 ||
      typeof entry.removable !== 'boolean' || typeof entry.custom !== 'boolean' ||
      typeof entry.hasError !== 'boolean') throw Error('invalid_bot_providers_result')
    seen.add(entry.id)
    let key: { configured: boolean; writable: boolean } | null = null
    if (entry.key !== null) {
      if (!record(entry.key) || !exact(entry.key, ['configured', 'writable']) ||
        typeof entry.key.configured !== 'boolean' || typeof entry.key.writable !== 'boolean')
        throw Error('invalid_bot_providers_result')
      key = { configured: entry.key.configured, writable: entry.key.writable }
    }
    modelCount += entry.models.length
    if (modelCount > 300) throw Error('invalid_bot_providers_result')
    const models = entry.models.map((model: unknown) => {
      if (!record(model) || !exact(model, ['ref', 'name']) ||
        !bounded(model.ref, 512) || !bounded(model.name, 256)) throw Error('invalid_bot_providers_result')
      return { ref: model.ref, name: model.name }
    })
    return { id: entry.id, name: entry.name, models, key,
      removable: entry.removable, custom: entry.custom, hasError: entry.hasError }
  })
  const addable = value.addable.map((entry: unknown) => {
    if (!record(entry) || !exact(entry, ['id', 'name']) || !providerID(entry.id) ||
      seen.has(entry.id) || !bounded(entry.name, 256)) throw Error('invalid_bot_providers_result')
    seen.add(entry.id)
    return { id: entry.id, name: entry.name }
  })
  if (value.protocols.some((id: unknown) => typeof id !== 'string' || !protocolIDs.has(id)) ||
    new Set(value.protocols).size !== value.protocols.length ||
    (!value.available && (providers.length > 0 || addable.length > 0 || value.protocols.length > 0)))
    throw Error('invalid_bot_providers_result')
  return { available: value.available, providers, addable, protocols: [...value.protocols] }
}
