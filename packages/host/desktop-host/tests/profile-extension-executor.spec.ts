import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ExtensionKind, ExtensionReceipt } from '../src/extension-operations.ts'
import { ProfileExtensionExecutor } from '../src/profile-extension-executor.ts'
import type { ProfileMcpExecutor } from '../src/profile-mcp-executor.ts'
import type { ProfilePluginExecutor } from '../src/profile-plugin-executor.ts'
import type { ProfileSkillExecutor } from '../src/profile-skill-executor.ts'

const receipt = {} as ExtensionReceipt
const context = (kind: ExtensionKind) => ({
  kind,
  signal: new AbortController().signal,
  guard() {},
})

function executor(label: string, revision: string, calls: string[]) {
  const call = (method: string, ...values: unknown[]): void => {
    calls.push(`${label}.${method}:${values.map(String).join(':')}`)
  }
  return {
    validate: (profileId: string, kind: ExtensionKind, payload: string) => { call('validate', profileId, kind, payload) },
    revision: async (profileId: string) => { call('revision', profileId); return revision },
    inventory: async (profileId: string, signal?: AbortSignal) => {
      call('inventory', profileId, signal === undefined ? 'no-signal' : 'signal')
      return [{ id: label, name: label, transport: 'fixture' }]
    },
    validatePluginCompletion: async (profileId: string, original: ExtensionReceipt) => { call('validatePluginCompletion', profileId, original === receipt) },
    completePluginPackage: async (profileId: string, original: ExtensionReceipt) => {
      call('completePluginPackage', profileId, original === receipt); return { state: 'succeeded' as const }
    },
    validatePluginRestore: async (profileId: string, original: ExtensionReceipt) => { call('validatePluginRestore', profileId, original === receipt) },
    restorePluginToggle: async (profileId: string, original: ExtensionReceipt) => {
      call('restorePluginToggle', profileId, original === receipt); return { state: 'succeeded' as const }
    },
    validateMcpRestore: async (profileId: string, original: ExtensionReceipt) => { call('validateMcpRestore', profileId, original === receipt) },
    restoreMcpConfig: async (profileId: string, original: ExtensionReceipt) => {
      call('restoreMcpConfig', profileId, original === receipt); return { state: 'succeeded' as const }
    },
    validateSkillRestore: async (profileId: string, original: ExtensionReceipt) => { call('validateSkillRestore', profileId, original === receipt) },
    restoreSkillRemoval: async (profileId: string, original: ExtensionReceipt) => {
      call('restoreSkillRemoval', profileId, original === receipt); return { state: 'succeeded' as const }
    },
    execute: async (profileId: string, payload: string, operation: { kind: ExtensionKind }) => {
      call('execute', profileId, payload, operation.kind); return { state: 'succeeded' as const }
    },
  }
}

describe('ProfileExtensionExecutor', () => {
  it('routes each operation to its owning installer and hashes every revision', async () => {
    const calls: string[] = []
    const mcp = executor('mcp', 'mcp-revision', calls)
    const skill = executor('skill', 'skill-revision', calls)
    const plugin = executor('plugin', 'plugin-revision', calls)
    const combined = new ProfileExtensionExecutor(
      mcp as unknown as ProfileMcpExecutor,
      skill as unknown as ProfileSkillExecutor,
      plugin as unknown as ProfilePluginExecutor,
    )

    for (const kind of ['mcp', 'skill', 'plugin'] as const) combined.validate('profile', kind, `${kind}-payload`)
    expect(await combined.revision('profile')).toBe(createHash('sha256')
      .update(JSON.stringify(['mcp-revision', 'skill-revision', 'plugin-revision'])).digest('hex'))
    const signal = new AbortController().signal
    expect(await combined.inventory('profile', 'skill', signal)).toHaveLength(1)
    expect(await combined.inventory('profile', 'mcp', signal)).toHaveLength(1)
    expect(await combined.inventory('profile', 'plugin', signal)).toHaveLength(1)
    await combined.validatePluginCompletion('profile', receipt)
    await combined.completePluginPackage('profile', receipt, context('plugin'))
    await combined.validatePluginRestore('profile', receipt)
    await combined.restorePluginToggle('profile', receipt, context('plugin'))
    await combined.validateMcpRestore('profile', receipt)
    await combined.restoreMcpConfig('profile', receipt, context('mcp'))
    await combined.validateSkillRestore('profile', receipt)
    await combined.restoreSkillRemoval('profile', receipt, context('skill'))
    for (const kind of ['mcp', 'skill', 'plugin'] as const) {
      await combined.execute('profile', `${kind}-payload`, context(kind))
    }

    expect(calls).toContain('skill.inventory:profile:signal')
    expect(calls).toContain('mcp.inventory:profile:no-signal')
    expect(calls).toContain('plugin.inventory:profile:no-signal')
    expect(calls.filter(call => call.endsWith('execute:profile:mcp-payload:mcp'))).toHaveLength(1)
    expect(calls.filter(call => call.endsWith('execute:profile:skill-payload:skill'))).toHaveLength(1)
    expect(calls.filter(call => call.endsWith('execute:profile:plugin-payload:plugin'))).toHaveLength(1)
  })

  it('keeps plugin routes unavailable when no plugin installer is configured', async () => {
    const calls: string[] = []
    const combined = new ProfileExtensionExecutor(
      executor('mcp', 'mcp-revision', calls) as unknown as ProfileMcpExecutor,
      executor('skill', 'skill-revision', calls) as unknown as ProfileSkillExecutor,
    )

    expect(await combined.revision('profile')).toBe(createHash('sha256')
      .update(JSON.stringify(['mcp-revision', 'skill-revision'])).digest('hex'))
    expect(() => { combined.validate('profile', 'plugin', 'payload') }).toThrow('upgrade_required')
    expect(() => combined.inventory('profile', 'plugin')).toThrow('upgrade_required')
    await expect(combined.validatePluginCompletion('profile', receipt)).rejects.toThrow('upgrade_required')
    await expect(combined.completePluginPackage('profile', receipt, context('plugin'))).rejects.toThrow('upgrade_required')
    await expect(combined.validatePluginRestore('profile', receipt)).rejects.toThrow('upgrade_required')
    await expect(combined.restorePluginToggle('profile', receipt, context('plugin'))).rejects.toThrow('upgrade_required')
  })
})
