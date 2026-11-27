/** Private wire contract between the Native parent and its attested Profile worker. */
export const PRIVATE_TWIN_WORKER_PATH = '/internal/slark-private-twin'
export const PRIVATE_TWIN_MAX_ANSWER_BYTES = 128 * 1024
const maxQuestionBytes = 32_000
export const PRIVATE_TWIN_WORKER_MAX_CLAIM_BYTES = 6 * maxQuestionBytes + 8192

interface PrivateTwinSource {
  readonly ticket: string
  readonly botId: string
  readonly sessionId: string
  readonly callId: string
  readonly rootCallId: string
  readonly sourceMessageId: string
}

export type PrivateTwinWorkerRequest = PrivateTwinSource & (
  | { readonly operation: 'send'; readonly content: string }
  | { readonly operation: 'read'; readonly receipt: string }
)

export type PrivateTwinWorkerResult =
  | { readonly state: 'unavailable' | 'pending' | 'failed' | 'unconfirmed' }
  | { readonly state: 'replied'; readonly answer: string | null }
  | { readonly state: 'accepted'; readonly receipt: string }
  | { readonly state: 'outcome_unknown'; readonly receipt?: string }

export type PrivateTwinWorkerCommand =
  | { readonly operation: 'claim' }
  | { readonly operation: 'check'; readonly ticket: string }
  | { readonly operation: 'finish'; readonly ticket: string; readonly result: PrivateTwinWorkerResult }

export type PrivateTwinWorkerReply =
  | { readonly request: PrivateTwinWorkerRequest | null }
  | { readonly current: true }
  | { readonly completed: true }

const invalid = (): never => { throw Error('invalid_private_twin_worker_frame') }

function record(value: unknown, exact?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
  const fields = Reflect.ownKeys(value)
  if (exact && (fields.length !== exact.length || exact.some(key => !fields.includes(key)))) return invalid()
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return invalid()
  }
  return value as Record<string, unknown>
}

function opaque(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 43 || Buffer.from(value, 'base64url').toString('base64url') !== value) return invalid()
  return value
}

function id(value: unknown): string {
  if (typeof value !== 'string' || /^[!-~]{1,256}$/u.exec(value)?.[0] !== value || /[/\\]/u.test(value)
    || value === '.' || value === '..') return invalid()
  return value
}

function text(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > bytes
    || Buffer.from(value).toString('utf8') !== value) return invalid()
  return value
}

/** Validate a worker result before sending it through the private endpoint. */
export function parsePrivateTwinWorkerResult(value: unknown): PrivateTwinWorkerResult {
  const input = record(value)
  switch (input.state) {
    case 'unavailable': case 'pending': case 'failed': case 'unconfirmed':
      record(input, ['state'])
      return { state: input.state }
    case 'replied':
      record(input, ['state', 'answer'])
      return { state: input.state, answer: input.answer === null ? null : text(input.answer, PRIVATE_TWIN_MAX_ANSWER_BYTES) }
    case 'accepted':
      record(input, ['state', 'receipt'])
      return { state: input.state, receipt: opaque(input.receipt) }
    case 'outcome_unknown':
      if (Object.hasOwn(input, 'receipt')) {
        record(input, ['state', 'receipt'])
        return { state: input.state, receipt: opaque(input.receipt) }
      }
      record(input, ['state'])
      return { state: input.state }
    default:
      return invalid()
  }
}

/** Validate one parent command, including the finite operation set and the payload bounds. */
export function parsePrivateTwinWorkerCommand(value: unknown): PrivateTwinWorkerCommand {
  const input = record(value)
  switch (input.operation) {
    case 'claim':
      record(input, ['operation'])
      return { operation: input.operation }
    case 'check':
      record(input, ['operation', 'ticket'])
      return { operation: input.operation, ticket: opaque(input.ticket) }
    case 'finish':
      record(input, ['operation', 'ticket', 'result'])
      return { operation: input.operation, ticket: opaque(input.ticket), result: parsePrivateTwinWorkerResult(input.result) }
    default:
      return invalid()
  }
}

/** Accept only the Worker response matching the original private operation. */
export function parsePrivateTwinWorkerReply(command: Extract<PrivateTwinWorkerCommand, { operation: 'claim' }>,
  value: unknown): Extract<PrivateTwinWorkerReply, { request: unknown }>
export function parsePrivateTwinWorkerReply(command: PrivateTwinWorkerCommand, value: unknown): PrivateTwinWorkerReply
export function parsePrivateTwinWorkerReply(command: PrivateTwinWorkerCommand, value: unknown): PrivateTwinWorkerReply {
  if (command.operation === 'check') {
    if (record(value, ['current']).current !== true) return invalid()
    return { current: true }
  }
  if (command.operation === 'finish') {
    if (record(value, ['completed']).completed !== true) return invalid()
    return { completed: true }
  }
  const request = record(value, ['request']).request
  if (request === null) return { request: null }
  const fields = record(request)
  const op = fields.operation
  if (op !== 'read' && op !== 'send') return invalid()
  record(fields, ['operation', 'ticket', 'botId', 'sessionId', 'callId', 'rootCallId', 'sourceMessageId',
    op === 'send' ? 'content' : 'receipt'])
  const base = { ticket: opaque(fields.ticket), botId: id(fields.botId), sessionId: id(fields.sessionId),
    callId: id(fields.callId), rootCallId: id(fields.rootCallId), sourceMessageId: id(fields.sourceMessageId) }
  return { request: op === 'send'
    ? { ...base, operation: op, content: text(fields.content, maxQuestionBytes) }
    : { ...base, operation: op, receipt: opaque(fields.receipt) } }
}
