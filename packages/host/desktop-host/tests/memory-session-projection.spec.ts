import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import { projectMemorySession } from '../src/memory-session-projection.ts'

const sessionId = 'session-54a5bf6e-b050-46f3-8149-f48b709b0480'
const header = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false }
const row = (type: string, seq: number, data: unknown, extras = {}) => ({ type, seq, time: seq + 2, data, ...extras })
const text = (value: string) => [{ type: 'text', text: value }]
const oneTurn = [
  row('turn/start', 0, { turn: 0 }),
  row('user/message', 1, { id: 'u', role: 'user', source: { kind: 'user' }, content: text('Please check password=abc123') }, { surfaceOp: 'append' }),
  row('user/message', 2, { id: 'injected', role: 'user', source: { kind: 'plugin' }, content: text('private system prompt') }),
  row('tool/call', 3, { arguments: 'secret raw tool body' }),
  row('assistant/message', 4, { message: { id: 'a', role: 'assistant', content: text('Done with token: xyz987') }, stream: ['raw reasoning'] }, { surfaceOp: 'append' }),
  row('turn/end', 5, { turn: 0, reason: { kind: 'completed' } }),
]
const snapshot = (events: unknown[], meta: object = header) => ({ sessionId, revision: 'r1', text: `${[meta, ...events].map(value => JSON.stringify(value)).join('\n')}\n` })

describe('local memory Session projection', () => {
  it('keeps completed human and final assistant text, redacts credentials, and excludes tool and injection bodies', () => {
    const result = projectMemorySession(snapshot(oneTurn))
    const sourceVersion = createHash('sha256').update('r1').digest('hex')
    expect(result).toEqual([
      { sessionId, sourceVersion, eventSeq: 1, turn: 0, kind: 'user', text: 'Please check password=[REDACTED]' },
      { sessionId, sourceVersion, eventSeq: 4, turn: 0, kind: 'assistant', text: 'Done with token: [REDACTED]' },
    ])
    expect(JSON.stringify(result)).not.toMatch(/secret raw tool body|private system prompt|raw reasoning|abc123|xyz987/u)
  })

  it('redacts an ai-proj personal token in natural Chinese text before indexing', () => {
    const fakeToken = `aiproj_pk_${'a1b2c3d4'.repeat(8)}`
    const events = oneTurn.map(event => event.seq === 1
      ? { ...event, data: { id: 'u', role: 'user', source: { kind: 'user' },
        content: text(`账号用 qiudl 的 token：${fakeToken}`) } } : event)
    const projected = projectMemorySession(snapshot(events))
    expect(projected[0]?.text).toBe('账号用 qiudl 的 token：[REDACTED]')
    expect(JSON.stringify(projected)).not.toContain(fakeToken)
  })

  it('ignores source projections and replacements on tool or system events', () => {
    const events = oneTurn.map(event => event.seq === 3
      ? { ...event, sourceEventSeqs: [2], surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } } : event)
    expect(projectMemorySession(snapshot(events))).toEqual(projectMemorySession(snapshot(oneTurn)))
  })

  it('keeps only visible assistant text from mixed reasoning and tool-call blocks', () => {
    const events = oneTurn.map(event => event.seq === 4
      ? { ...event, data: { ...event.data, message: { id: 'a', role: 'assistant', content: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'text', text: 'Visible answer' },
        { type: 'tool-call', arguments: 'private tool arguments' },
      ] } } } : event)
    const result = projectMemorySession(snapshot(events))
    expect(result.find(item => item.kind === 'assistant')?.text).toBe('Visible answer')
    expect(JSON.stringify(result)).not.toMatch(/private reasoning|private tool arguments/u)
  })

  it('withholds unfinished or failed turns and refuses delegated or replaced history', () => {
    expect(projectMemorySession(snapshot(oneTurn.slice(0, -1)))).toEqual([])
    const failed = oneTurn.map(event => event.type === 'turn/end'
      ? { ...event, data: { turn: 0, reason: { kind: 'error' } } } : event)
    expect(projectMemorySession(snapshot(failed))).toEqual([])
    expect(() => projectMemorySession(snapshot(oneTurn, { ...header, parentSession: 'another' }))).toThrow()
    const replaced = oneTurn.map(event => event.seq === 1
      ? { ...event, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } } : event)
    expect(() => projectMemorySession(snapshot(replaced))).toThrow()
  })

  it('refuses ambiguous secrets, malformed event order, and unknown format', () => {
    const secret = oneTurn.map(event => event.seq === 1
      ? { ...event, data: { id: 'u', role: 'user', source: { kind: 'user' }, content: text('password="unterminated') } } : event)
    expect(() => projectMemorySession(snapshot(secret))).toThrow()
    const cnSecret = oneTurn.map(event => event.seq === 1
      ? { ...event, data: { id: 'u', role: 'user', source: { kind: 'user' }, content: text('密码是"未闭合') } } : event)
    expect(() => projectMemorySession(snapshot(cnSecret))).toThrow()
    expect(() => projectMemorySession(snapshot(oneTurn.filter(event => event.seq !== 3)))).toThrow()
    expect(() => projectMemorySession(snapshot(oneTurn, { ...header, version: SESSION_FORMAT_VERSION + 1 }))).toThrow()
  })
})
