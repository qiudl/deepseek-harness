import { describe, expect, it } from 'vitest'
import { LegacyClaimRecoveryStore, type LegacyClaimRecoveryFiles } from '../src/legacy-claim-recovery.ts'
import { LegacyClaimTarget, type LegacyClaimTargetFiles } from '../src/legacy-claim-target.ts'

const profileId = 'b9e8b0aa-5c8e-4d4c-8e7a-139a86985f41'
const operationId = '97086a03-9508-41c0-bec3-7464dc835953'
const sourceSettings = { 'llm-deepseek': { apiKeyEnv: 'SHARED_KEY', baseURL: 'https://api.deepseek.com' } }
const sourceCredentials = { refs: { SHARED_KEY: 'legacy-secret' }, records: {} }
const input = {
  profileId, operationId, candidateId: 'llm-deepseek:deepseek', targetGeneration: 1,
  sourceSettings, sourceCredentials, guard: () => undefined,
}

function fixture() {
  let settings: Buffer = Buffer.from('{"ui":{"theme":"dark"}}\n')
  let credentials: Buffer = Buffer.from('{"version":1,"refs":{"PERSONAL":"private-secret"},"records":{}}\n')
  let snapshot: Buffer | undefined
  let fault: 'settings' | 'credentials' | undefined
  const files: LegacyClaimTargetFiles = {
    read: kind => Buffer.from(kind === 'settings' ? settings : credentials),
    replace: (kind, bytes) => {
      if (kind === fault) throw Error('write_interrupted')
      if (kind === 'settings') settings = Buffer.from(bytes)
      else credentials = Buffer.from(bytes)
    },
  }
  const recoveryFiles: LegacyClaimRecoveryFiles = {
    read: () => snapshot === undefined ? undefined : Buffer.from(snapshot),
    replace: (_profileId, _operationId, bytes) => { snapshot = Buffer.from(bytes) },
    remove: () => { snapshot = undefined },
  }
  const recovery = new LegacyClaimRecoveryStore(recoveryFiles)
  return {
    files, recovery, target: new LegacyClaimTarget(files, recovery),
    current: () => ({ settings, credentials }),
    change: (kind: 'settings' | 'credentials', bytes: Buffer) => {
      if (kind === 'settings') settings = bytes
      else credentials = bytes
    },
    interrupt: (kind: 'settings' | 'credentials' | undefined) => { fault = kind },
    snapshot: () => snapshot,
  }
}

describe('one-provider claim target document pair', () => {
  it('writes only the projected provider and verifies both worker-visible documents', () => {
    const state = fixture()
    const before = state.current()
    const prepared = state.target.prepare(input)
    expect(state.current()).toEqual(before)
    expect(state.snapshot()).toBeDefined()
    state.target.publish(prepared, input.guard)
    const after = state.current()
    expect(after.settings).toEqual(prepared.settingsAfter)
    expect(after.credentials).toEqual(prepared.credentialsAfter)
    expect(after.settings.toString()).not.toContain('legacy-secret')
    expect(after.settings.toString()).toContain('dark')
    expect(after.credentials.toString()).toContain('private-secret')
    state.target.verify(prepared.recovery, input.guard)
    state.target.publish(prepared, input.guard)
    expect(state.current()).toEqual(after)
  })

  it('resumes after one document was written and restores the original pair', () => {
    const state = fixture()
    const before = state.current()
    const prepared = state.target.prepare(input)
    state.interrupt('settings')
    expect(() => { state.target.publish(prepared, input.guard) }).toThrow('write_interrupted')
    expect(state.current().credentials).toEqual(prepared.credentialsAfter)
    expect(state.current().settings).toEqual(before.settings)
    state.interrupt(undefined)
    const retry = state.target.prepare(input)
    expect(retry.recovery).toEqual(prepared.recovery)
    state.target.publish(retry, input.guard)
    state.target.restore(retry.recovery, input.guard)
    expect(state.current()).toEqual(before)
    state.target.restore(retry.recovery, input.guard)
  })

  it('refuses later personal edits and a forged or missing snapshot', () => {
    const state = fixture()
    const prepared = state.target.prepare(input)
    state.change('settings', Buffer.from('{"personal":"later"}\n'))
    expect(() => { state.target.verify(prepared.recovery, input.guard) }).toThrow(/conflict/u)
    expect(() => { state.target.publish(prepared, input.guard) }).toThrow(/conflict/u)
    expect(() => { state.target.restore(prepared.recovery, input.guard) }).toThrow(/conflict/u)
    expect(() => state.target.prepare(input)).toThrow(/conflict/u)
    state.change('settings', prepared.recovery.settingsBefore)
    expect(() => { state.target.publish({ ...prepared, settingsAfter: Buffer.from('{}\n') }, input.guard) })
      .toThrow(/unavailable/u)
    expect(() => { state.target.restore({ ...prepared.recovery, candidateId: 'llm-pi-ai:other' }, input.guard) })
      .toThrow(/unavailable/u)
    expect(() => { state.target.verify({ ...prepared.recovery, candidateId: 'llm-pi-ai:other' }, input.guard) })
      .toThrow(/unavailable/u)
    const missing = new LegacyClaimTarget(state.files, new LegacyClaimRecoveryStore({
      read: () => undefined, replace: () => undefined, remove: () => undefined,
    }))
    expect(() => { missing.publish(prepared, input.guard) }).toThrow(/unavailable/u)
  })

  it('keeps the worker fenced when a guard is revoked or verification fails', () => {
    const state = fixture()
    const prepared = state.target.prepare(input)
    expect(() => { state.target.publish(prepared, () => { throw Error('stale') }) }).toThrow('stale')
    let reads = 0
    const changed: LegacyClaimTargetFiles = {
      read: (kind) => {
        reads += 1
        if (reads > 2 && kind === 'settings') return Buffer.from('{}\n')
        return state.files.read(kind)
      },
      replace: (kind, bytes) => { state.files.replace(kind, bytes) },
    }
    expect(() => { new LegacyClaimTarget(changed, state.recovery).publish(prepared, input.guard) })
      .toThrow(/unavailable/u)
  })

  it('rejects invalid YAML and unsupported credential documents before a snapshot', () => {
    const state = fixture()
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from('['), Buffer.from('[]'),
      Buffer.from('key: a\nkey: b\n'), Buffer.alloc(16 * 1024 * 1024 + 1)]) {
      state.change('settings', bytes)
      expect(() => state.target.prepare(input)).toThrow()
    }
    state.change('settings', Buffer.from('{}\n'))
    for (const bytes of [Buffer.from('{}\n'), Buffer.from('{"version":2,"refs":{},"records":{}}\n'),
      Buffer.from('{"version":1,"refs":[],"records":{}}\n')]) {
      state.change('credentials', bytes)
      expect(() => state.target.prepare(input)).toThrow()
    }
    state.change('credentials', Buffer.from('{"version":1,"refs":{},"records":{}}\n'))
    expect(() => state.target.prepare({ ...input, sourceSettings: {
      'llm-deepseek': { apiKeyEnv: 'SHARED_KEY', baseURL: 'x'.repeat(16 * 1024 * 1024) },
    } })).toThrow(/invalid_input/u)
  })

  it('stops restoration on a concurrent edit or failed final verification', () => {
    const state = fixture()
    const prepared = state.target.prepare(input)
    state.target.publish(prepared, input.guard)
    let reads = 0
    const changing: LegacyClaimTargetFiles = {
      read: (kind) => {
        reads += 1
        if (reads === 4 && kind === 'settings') return Buffer.from('{"later":"edit"}\n')
        return state.files.read(kind)
      },
      replace: (kind, bytes) => { state.files.replace(kind, bytes) },
    }
    expect(() => { new LegacyClaimTarget(changing, state.recovery).restore(prepared.recovery, input.guard) })
      .toThrow(/conflict/u)
    const ineffective: LegacyClaimTargetFiles = {
      read: kind => state.files.read(kind), replace: () => undefined,
    }
    expect(() => { new LegacyClaimTarget(ineffective, state.recovery).restore(prepared.recovery, input.guard) })
      .toThrow(/unavailable/u)
  })
})
