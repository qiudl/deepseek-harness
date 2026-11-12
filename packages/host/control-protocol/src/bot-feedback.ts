/** Redacted diagnostic preview from the selected Profile's DS Bot. */
import { botExactKeys as exact, botRecord as record } from './bot-value-shape.js'

const ISSUE_URL = 'https://github.com/Fei2411/DeepSeek-Bot/issues/new'
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max

/** An empty request for the selected Bot diagnostic preview. */
export type HostBotFeedbackRequest = Readonly<Record<string, never>>
/** A bounded, redacted diagnostic preview and issue URL. */
export type HostBotFeedback = Readonly<{
  total: number
  entries: readonly Readonly<{
    time: number
    level: 'error' | 'warn'
    source: 'turn' | 'host' | 'api' | 'browser'
    text: string
    code: string | null
  }>[]
  markdown: string
  markdownTruncated: boolean
  issuesUrl: string
}>

const validLevel = (value: unknown): value is HostBotFeedback['entries'][number]['level'] =>
  value === 'error' || value === 'warn'
const validSource = (value: unknown): value is HostBotFeedback['entries'][number]['source'] =>
  value === 'turn' || value === 'host' || value === 'api' || value === 'browser'

/**
 * Validate the bot feedback request at the native Host boundary.
 * @param value - Untrusted payload to validate.
 * @returns The validated bot feedback request.
 */
export function parseHostBotFeedbackRequest(value: unknown): HostBotFeedbackRequest {
  if (!record(value) || !exact(value, [])) throw Error('invalid_bot_feedback_request')
  return {}
}

/**
 * Validate the bot feedback at the native Host boundary.
 * @param value - Untrusted payload to validate.
 * @returns The validated bot feedback.
 */
export function parseHostBotFeedback(value: unknown): HostBotFeedback | null {
  if (value === null) return null
  if (!record(value) || !exact(value, ['total', 'entries', 'markdown', 'markdownTruncated', 'issuesUrl']) ||
    typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0 || value.total > 200 ||
    !Array.isArray(value.entries) || value.entries.length > 8 ||
    !bounded(value.markdown, 50_000) || typeof value.markdownTruncated !== 'boolean' ||
    value.issuesUrl !== ISSUE_URL || Buffer.byteLength(JSON.stringify(value), 'utf8') > 70_000)
    throw Error('invalid_bot_feedback_result')
  const entries = value.entries.map((entry: unknown) => {
    if (!record(entry) || !exact(entry, ['time', 'level', 'source', 'text', 'code']) ||
      typeof entry.time !== 'number' || !Number.isSafeInteger(entry.time) || entry.time < 0 ||
      !validLevel(entry.level) || !validSource(entry.source) ||
      !bounded(entry.text, 2000) || !(entry.code === null || bounded(entry.code, 40)))
      throw Error('invalid_bot_feedback_result')
    return { time: entry.time, level: entry.level, source: entry.source,
      text: entry.text, code: entry.code }
  })
  return { total: value.total, entries, markdown: value.markdown,
    markdownTruncated: value.markdownTruncated, issuesUrl: ISSUE_URL }
}
