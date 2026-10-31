import { afterEach, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({ call: 0, at: 0, mode: '' }))
vi.mock('@deepseek-ai/dsh-app-boot', async (load) => {
  const actual = await load<typeof import('@deepseek-ai/dsh-app-boot')>()
  return { ...actual, composeEntries: (...args: Parameters<typeof actual.composeEntries>) => {
    const entries = actual.composeEntries(...args)
    if (++fault.call !== fault.at) return entries
    if (fault.mode === 'duplicate') return [...entries, entries[0]]
    if (fault.mode === 'missing') return entries.filter(entry => entry.id !== 'web')
    return entries.map(entry => entry.id === 'web' ? { ...entry, config: { altered: true } } : entry)
  } }
})
const { planPluginUpgrade } = await import('../src/plugin-upgrade-plan.ts')
afterEach(() => { fault.call = 0; fault.at = 0; fault.mode = '' })
const base = { packageName: 'base', patches: [{ insert: [{ id: 'web', name: 'web', config: { provider: 'base' } }] }] }
const legacy = { packageName: 'bot', patches: [{ insert: [{ id: 'bot', name: 'bot' }] }, { id: 'web', config: { provider: 'legacy' } }] }
const target = { packageName: 'bot', patches: [{ insert: [{ id: 'bot', name: 'bot' }] }] }

it.each([[1, 'duplicate'], [2, 'missing'], [4, 'changed'], [5, 'changed']] as const)(
  'rejects inconsistent composition at stage %s', (at, mode) => {
    fault.at = at; fault.mode = mode
    expect(() => planPluginUpgrade([base, legacy], [base, target], '', [], 'bot')).toThrow('plugin_upgrade_shared_entry_changed')
  },
)
