import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionScopeProviderId, SessionScopeReference } from '@deepseek-ai/dsh-session'
import { migrationSemanticRecords } from '../src/migration-export.ts'

function header(scope: boolean) {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId('scope-digest'),
    createdAt: 1,
    isSeeded: false,
    ...(scope
      ? {
        scope: {
          provider: SessionScopeProviderId('example.scope'),
          ref: SessionScopeReference('opaque:subject:1'),
          schemaVersion: 1,
        },
      }
      : {}),
  }
}

describe('migration semantic records include plugin-owned scope (REQ-20260907-0021 P5d)', () => {
  it('distinguishes sessions that differ only by scope', () => {
    const plain = migrationSemanticRecords([{ header: header(false), events: [] }])
    const scoped = migrationSemanticRecords([{ header: header(true), events: [] }])
    expect(scoped[0]?.payloadDigest).not.toBe(plain[0]?.payloadDigest)
  })

  it('keeps the plain digest stable when no scope is present', () => {
    const a = migrationSemanticRecords([{ header: header(false), events: [] }])
    const b = migrationSemanticRecords([{ header: header(false), events: [] }])
    expect(a[0]?.payloadDigest).toBe(b[0]?.payloadDigest)
  })
})
