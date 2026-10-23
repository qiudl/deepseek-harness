/** REQ-20261021-0013: bounded, local-only projection of current-format Session text. */
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createHash } from 'node:crypto'
import type { HostMemorySessionSnapshot } from './types.ts'
import { HostAuthorityError } from './types.ts'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const MAX_BYTES = 64 * 1024 * 1024
const MAX_EVENTS = 100_000
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_PROJECTED_RECORDS = 20_000
const CREDENTIAL_LABEL = String.raw`(?:password|passwd|passphrase|passcode|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization)`
const QUOTED_CREDENTIAL_LABEL = new RegExp(String.raw`["'](?:${CREDENTIAL_LABEL}|密码|口令|密钥|令牌|凭据|凭证)["']`, 'iu')
const QUOTED_ASSIGNMENT = new RegExp(String.raw`(?:\b${CREDENTIAL_LABEL}|密码|口令|密钥|令牌|凭据|凭证)\s*(?:[:：=]|\bis\b|是|为)\s*(["'])`, 'giu')
const ASSIGNMENT = new RegExp(String.raw`\b(${CREDENTIAL_LABEL})(\s*(?:[:：=]|\bis\b|是|为)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;，；、。]+)`, 'giu')
const CN_ASSIGNMENT = /(密码|口令|密钥|令牌|凭据|凭证)(\s*(?:为|是|[:：=])\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;，；、]+)/gu
const INCOMPLETE_ASSIGNMENT = new RegExp(String.raw`\b${CREDENTIAL_LABEL}\s*(?:[:：=]|\bis\b|是|为)\s*(?:$|["']$)`, 'iu')
const UNTERMINATED_QUOTE = new RegExp(String.raw`\b${CREDENTIAL_LABEL}\s*(?:[:：=]|\bis\b|是|为)\s*["'][^"']*$`, 'iu')
const CN_UNTERMINATED_QUOTE = /(密码|口令|密钥|令牌|凭据|凭证)\s*(?:为|是|[:：=])\s*["'][^"']*$/u

export interface MemoryProjectedRecord {
  readonly sessionId: string
  readonly sourceVersion: string
  readonly eventSeq: number
  readonly turn: number
  readonly kind: 'user' | 'assistant'
  readonly text: string
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let score = 0
  for (const count of counts.values()) {
    const fraction = count / value.length
    score -= fraction * Math.log2(fraction)
  }
  return score
}

function suspiciousOpaqueToken(value: string): boolean {
  // A bare commit-like digest may be an unlabeled bearer credential.
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/iu.test(value)) return true
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u].filter(pattern => pattern.test(value)).length
  return classes >= 2 && entropy(value) >= 3.6
}

function malformedQuotedAssignment(input: string): boolean {
  for (const match of input.matchAll(QUOTED_ASSIGNMENT)) {
    const quote = match[1]
    let index = (match.index ?? 0) + match[0].length
    let closed = false
    while (index < input.length) {
      if (input[index] === '\\') {
        index += 2
        continue
      }
      if (input[index] === quote) {
        index += 1
        closed = true
        break
      }
      index += 1
    }
    if (!closed || (index < input.length && !/[\s,;，；、。！？}\])]/u.test(input.slice(index, index + 1)))) return true
  }
  return false
}

function redactText(input: string): string {
  if (Buffer.byteLength(input, 'utf8') > MAX_MESSAGE_BYTES
    || QUOTED_CREDENTIAL_LABEL.test(input)
    || malformedQuotedAssignment(input)
    || /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input)
    || (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(input)
      && !/-----END [A-Z0-9 ]*PRIVATE KEY-----/u.test(input))
    || UNTERMINATED_QUOTE.test(input) || CN_UNTERMINATED_QUOTE.test(input))
    throw new HostAuthorityError('unavailable')
  const text = input
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Authorization\s*[:：=]\s*)[^\r\n,;，；、。！？]+/giu, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s,;，；、。！？：]+/giu, '$1[REDACTED]')
    .replace(/\b(?:aiproj_pk_[A-Za-z0-9_-]{32,}|gh[porsu]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|sk-[A-Za-z0-9_-]{20,})\b/gu, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(ASSIGNMENT, (_full, label: string, separator: string) => `${label}${separator}[REDACTED]`)
    .replace(CN_ASSIGNMENT, (_full, label: string, separator: string) => `${label}${separator}[REDACTED]`)
    .replace(/[A-Za-z0-9_+/-]{32,}={0,2}/gu, value => suspiciousOpaqueToken(value) ? '[REDACTED]' : value)
  if (INCOMPLETE_ASSIGNMENT.test(text) || /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(text))
    throw new HostAuthorityError('unavailable')
  return text
}

function plainText(message: Record<string, unknown> | null, role: string): string | null {
  if (message?.role !== role || !Array.isArray(message.content)) return null
  let text = ''
  for (const content of message.content) {
    const block = object(content)
    if (!block) return null
    if (role === 'assistant' && (block.type === 'reasoning' || block.type === 'tool-call')) continue
    if (block.type !== 'text' || typeof block.text !== 'string') return null
    text += block.text
  }
  return text ? redactText(text) : null
}

/** No raw message, tool payload, system prompt, or mutable surface history leaves this call. */
export function projectMemorySession(snapshot: HostMemorySessionSnapshot): readonly MemoryProjectedRecord[] {
  if (!SESSION_ID.test(snapshot.sessionId) || !snapshot.revision || snapshot.revision.length > 256
    || Buffer.byteLength(snapshot.text, 'utf8') > MAX_BYTES) throw new HostAuthorityError('invalid_input')
  const sourceVersion = createHash('sha256').update(snapshot.revision).digest('hex')
  const lines = snapshot.text.split('\n')
  if (lines.length > MAX_EVENTS + 2 || lines.at(-1) !== '') throw new HostAuthorityError('unavailable')
  let header: unknown
  try { header = JSON.parse(lines[0] || '') } catch { throw new HostAuthorityError('unavailable') }
  const meta = object(header)
  if (!meta || meta.id !== snapshot.sessionId || meta.version !== SESSION_FORMAT_VERSION
    || meta.isSeeded !== false || (meta.delegationDepth !== undefined && meta.delegationDepth !== 0)
    || meta.parentSession !== undefined || meta.origin !== undefined)
    throw new HostAuthorityError('unavailable')
  const records: MemoryProjectedRecord[] = []
  let nextSeq = 0
  let pending: { turn: number; user: MemoryProjectedRecord[]; assistant?: MemoryProjectedRecord } | null = null
  for (const line of lines.slice(1, -1)) {
    if (!line) throw new HostAuthorityError('unavailable')
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { throw new HostAuthorityError('unavailable') }
    const event = object(parsed), data = object(event?.data)
    if (!event || event.seq !== nextSeq || typeof event.type !== 'string') throw new HostAuthorityError('unavailable')
    const projectedEvent = event.type === 'turn/start' || event.type === 'turn/end'
      || event.type === 'user/message' || event.type === 'assistant/message'
    if (projectedEvent && ((event.surfaceOp !== undefined && event.surfaceOp !== 'append')
      || event.sourceEventSeqs !== undefined)) throw new HostAuthorityError('unavailable')
    nextSeq += 1
    if (event.type === 'turn/start') {
      const turn = data?.turn
      if (pending || typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0) throw new HostAuthorityError('unavailable')
      pending = { turn, user: [] }
    } else if (event.type === 'turn/end') {
      if (!pending || data?.turn !== pending.turn) throw new HostAuthorityError('unavailable')
      if (object(data.reason)?.kind === 'completed') {
        records.push(...pending.user)
        if (pending.assistant) records.push(pending.assistant)
      }
      pending = null
    } else if (event.type === 'user/message' || event.type === 'assistant/message') {
      if (!pending) throw new HostAuthorityError('unavailable')
      if (event.type === 'user/message' && object(data?.source)?.kind !== 'user') continue
      const kind = event.type === 'user/message' ? 'user' : 'assistant'
      const message = kind === 'user' ? data : object(data?.message)
      const text = plainText(message, kind)
      if (text === null) continue
      const record = { sessionId: snapshot.sessionId, sourceVersion,
        eventSeq: event.seq, turn: pending.turn, kind, text } as const
      if (kind === 'user') pending.user.push(record)
      else pending.assistant = record
    }
    if (records.length > MAX_PROJECTED_RECORDS) throw new HostAuthorityError('unavailable')
  }
  return records
}
