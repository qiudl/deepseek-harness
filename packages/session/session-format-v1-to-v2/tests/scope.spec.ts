import { describe, expect, it } from 'vitest'
import type { SessionFormatArtifact, SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV2SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v1-to-v2'

const SCOPE = { provider: 'example.scope', ref: 'opaque:subject:1', schemaVersion: 1 } as const

function artifactWithScope(): SessionFormatArtifact {
  return {
    header: {
      version: 2,
      id: 'scope-session',
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      scope: SCOPE,
    },
    inheritedEventCount: 0,
    events: [],
  }
}

describe('released v2 plugin-owned scope header (REQ-20260907-0021 fork overlay)', () => {
  it('round-trips scope through physical encode/decode', () => {
    const encoded = releasedV2SessionFormatCodec.encodeArtifact(artifactWithScope())
    expect(encoded.header).toMatchObject({ scope: SCOPE })
    const decoded = releasedV2SessionFormatCodec.decodeArtifact(encoded.header, encoded.rows)
    expect(decoded.header.scope).toEqual(SCOPE)
  })

  it('keeps physical headers scope-free when the artifact has none', () => {
    const encoded = releasedV2SessionFormatCodec.encodeArtifact({
      header: { version: 2, id: 'plain', createdAt: 1, isSeeded: false, delegationDepth: 0 },
      inheritedEventCount: 0,
      events: [],
    })
    expect((encoded.header as SessionFormatJsonObject & { scope?: unknown }).scope).toBeUndefined()
  })

  it('rejects a malformed scope record', () => {
    expect(() => releasedV2SessionFormatCodec.decodeArtifact(
      { ...artifactWithScope().header, type: 'session', scope: { provider: '', ref: 'x', schemaVersion: 1 } },
      [],
    )).toThrow(/scope provider must be a non-empty string/)
  })
})
