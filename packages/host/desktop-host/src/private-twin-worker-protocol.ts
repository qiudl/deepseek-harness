/** Private wire contract between the Native parent and its attested Profile worker. */
import { parseHostBindingWorkerEvidence, type HostBindingWorkerEvidence } from '@deepseek-ai/dsh-host-control-protocol'
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
  | { readonly operation: 'binding_intent'; readonly intent: HostBindingWorkerEvidence }
  | { readonly operation: 'binding_receipt'; readonly receipt: string }
  | { readonly operation: 'binding_confirmation'; readonly confirmation: BindingConfirmation }
  | { readonly operation: 'binding_propose'; readonly proposal: BindingProposal }
  | { readonly operation: 'binding_targets'; readonly lookup: BindingTargetLookup }
)

type Presentation = Readonly<{ ref: string; callId: string; resultSeq: number }>
type BindingKind = 'twin' | 'group'
type BindingAction = 'bind' | 'replace' | 'end'
type BindingProposal = Readonly<{
  kind: BindingKind
  action: BindingAction
  sourceRef: string
  sourceId: string
  targetRef: string | null
  defaultAgentRef: string | null
  messageSeq: number
}>
type BindingTargetLookup = Readonly<{
  kind: BindingKind
  sourceRef: string
  sourceId: string
  query: string | null
  targetRef: string | null
  cursor: string | null
}>
type BindingTargetPage = Readonly<{
  state: 'candidates'
  category: 'target' | 'default_agent'
  kind: BindingKind
  items: readonly Readonly<{ ref: string; display_name: string; availability: 'eligible' | 'occupied' }>[]
  next_cursor: string | null
}>
type BindingPreviewDisplay = Readonly<{
  sourceName: string
  previousTarget: string | null
  targetName: string | null
  defaultAgent: string | null
  impact: string
}>
type BindingConfirmation = Readonly<{
  messageSeq: number
  text: string
  proposalRef: string | null
  presentations: readonly Presentation[]
}>
type BindingApproval = Readonly<{
  state: 'confirmed'
  kind: BindingKind
  sourceId: string
  requestId: string
  previewDigest: string
  commandDigest: string
  confirmationMessageId: string
  confirmationMessageSeq: number
  expiresAt: number
}>

export type PrivateTwinWorkerResult =
  | { readonly state: 'unavailable' | 'pending' | 'failed' | 'unconfirmed' }
  | { readonly state: 'replied'; readonly answer: string | null }
  | { readonly state: 'accepted' | 'active'; readonly receipt: string }
  | { readonly state: 'binding_status'; readonly status: 'accepted' | 'in_progress' | 'active' | 'ended' | 'cancelled' | 'denied' | 'conflict' | 'outcome_unknown' | 'missing' }
  | { readonly state: 'outcome_unknown'; readonly receipt?: string }
  | { readonly state: 'needs_confirmation' | 'selection_required' | 'stale' | 'cancelled' | 'conflict' | 'denied' }
  | { readonly state: 'consent_recorded'; readonly remaining: 'dsh_to_slark' | 'slark_to_dsh'; readonly label: number }
  | { readonly state: 'binding_confirmation'; readonly approval: BindingApproval }
  | BindingTargetPage
  | Readonly<{
    state: 'preview'
    proposalRef: string
    label: number
    kind: BindingKind
    action: BindingAction
    display: BindingPreviewDisplay
  }>

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

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid()
}

function matched(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value ? value : invalid()
}

function bindingAction(kind: unknown, action: unknown): { kind: BindingKind; action: BindingAction } {
  if ((kind !== 'twin' && kind !== 'group') || (action !== 'bind' && action !== 'replace' && action !== 'end')) return invalid()
  return { kind, action }
}

function parseBindingProposal(input: unknown): BindingProposal {
  const row = record(input, ['kind', 'action', 'sourceRef', 'sourceId', 'targetRef', 'defaultAgentRef', 'messageSeq'])
  const { kind, action } = bindingAction(row.kind, row.action)
  if ((action === 'end') !== (row.targetRef === null) ||
      ((kind !== 'group' || action === 'end') && row.defaultAgentRef !== null)) return invalid()
  return { kind, action, sourceRef: opaque(row.sourceRef), sourceId: id(row.sourceId),
    targetRef: row.targetRef === null ? null : opaque(row.targetRef),
    defaultAgentRef: row.defaultAgentRef === null ? null : opaque(row.defaultAgentRef), messageSeq: positive(row.messageSeq) }
}

function parseBindingTargetLookup(input: unknown): BindingTargetLookup {
  const row = record(input, ['kind', 'sourceRef', 'sourceId', 'query', 'targetRef', 'cursor'])
  const { kind, query } = row
  if ((kind !== 'twin' && kind !== 'group') || (kind === 'twin' && row.targetRef !== null) ||
      (query !== null && (typeof query !== 'string' || query.length > 200 || /\p{Cc}/u.test(query) ||
        Buffer.from(query).toString('utf8') !== query))) return invalid()
  return { kind, query, sourceRef: opaque(row.sourceRef), sourceId: id(row.sourceId),
    targetRef: row.targetRef === null ? null : opaque(row.targetRef), cursor: row.cursor === null ? null : opaque(row.cursor) }
}

function parseBindingTargetPage(input: Record<string, unknown>): BindingTargetPage {
  record(input, ['state', 'category', 'kind', 'items', 'next_cursor'])
  const { kind, category, items } = input
  if ((kind !== 'twin' && kind !== 'group') ||
      (category !== 'target' && (category !== 'default_agent' || kind !== 'group')) ||
      !Array.isArray(items) || items.length > 20) return invalid()
  const entries = items.map((raw): BindingTargetPage['items'][number] => {
    const row = record(raw, ['ref', 'display_name', 'availability'])
    const label = text(row.display_name, 8000), availability = row.availability
    if (label.length > 2000 || /\p{Cc}/u.test(label) || (availability !== 'eligible' && availability !== 'occupied')) return invalid()
    return { ref: opaque(row.ref), display_name: label, availability }
  })
  return { state: 'candidates', category, kind, items: entries,
    next_cursor: input.next_cursor === null ? null : opaque(input.next_cursor) }
}

function previewLabel(raw: unknown): string {
  const value = text(raw, 800)
  return value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : invalid()
}

function parseBindingPreviewDisplay(raw: unknown): BindingPreviewDisplay {
  const row = record(raw, ['sourceName', 'previousTarget', 'targetName', 'defaultAgent', 'impact'])
  return { sourceName: previewLabel(row.sourceName), impact: previewLabel(row.impact),
    previousTarget: row.previousTarget === null ? null : previewLabel(row.previousTarget),
    targetName: row.targetName === null ? null : previewLabel(row.targetName),
    defaultAgent: row.defaultAgent === null ? null : previewLabel(row.defaultAgent) }
}

function parseBindingConfirmation(raw: unknown): BindingConfirmation {
  const row = record(raw, ['messageSeq', 'text', 'proposalRef', 'presentations'])
  if (!Array.isArray(row.presentations) || row.presentations.length > 16) return invalid()
  return { messageSeq: positive(row.messageSeq), text: text(row.text, 4096),
    proposalRef: row.proposalRef === null ? null : opaque(row.proposalRef), presentations: row.presentations.map((raw) => {
      const item = record(raw, ['ref', 'callId', 'resultSeq'])
      return { ref: opaque(item.ref), callId: id(item.callId), resultSeq: positive(item.resultSeq) }
    }) }
}

function parseBindingApproval(raw: unknown): BindingApproval {
  const row = record(raw, ['state', 'kind', 'sourceId', 'requestId', 'previewDigest', 'commandDigest',
    'confirmationMessageId', 'confirmationMessageSeq', 'expiresAt'])
  if (row.state !== 'confirmed' || (row.kind !== 'twin' && row.kind !== 'group')) return invalid()
  return { state: 'confirmed', kind: row.kind, sourceId: id(row.sourceId),
    requestId: matched(row.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    previewDigest: matched(row.previewDigest, /^[a-f0-9]{64}$/u), commandDigest: matched(row.commandDigest, /^[a-f0-9]{64}$/u),
    confirmationMessageId: id(row.confirmationMessageId), confirmationMessageSeq: positive(row.confirmationMessageSeq),
    expiresAt: positive(row.expiresAt) }
}

/** Validate a worker result before sending it through the private endpoint. */
export function parsePrivateTwinWorkerResult(value: unknown): PrivateTwinWorkerResult {
  const input = record(value)
  switch (input.state) {
    case 'unavailable': case 'pending': case 'failed': case 'unconfirmed':
    case 'needs_confirmation': case 'selection_required': case 'stale': case 'cancelled': case 'conflict': case 'denied':
      record(input, ['state'])
      return { state: input.state }
    case 'replied':
      record(input, ['state', 'answer'])
      return { state: input.state, answer: input.answer === null ? null : text(input.answer, PRIVATE_TWIN_MAX_ANSWER_BYTES) }
    case 'accepted': case 'active':
      record(input, ['state', 'receipt'])
      return { state: input.state, receipt: opaque(input.receipt) }
    case 'binding_status': {
      record(input, ['state', 'status'])
      const status = input.status
      if (status !== 'accepted' && status !== 'in_progress' && status !== 'active' && status !== 'ended' && status !== 'cancelled' &&
          status !== 'denied' && status !== 'conflict' && status !== 'outcome_unknown' && status !== 'missing') return invalid()
      return { state: input.state, status }
    }
    case 'outcome_unknown':
      if (Object.hasOwn(input, 'receipt')) {
        record(input, ['state', 'receipt'])
        return { state: input.state, receipt: opaque(input.receipt) }
      }
      record(input, ['state'])
      return { state: input.state }
    case 'binding_confirmation':
      record(input, ['state', 'approval'])
      return { state: input.state, approval: parseBindingApproval(input.approval) }
    case 'consent_recorded': {
      record(input, ['state', 'remaining', 'label'])
      const label = positive(input.label)
      if (label > 999_999_999 || (input.remaining !== 'dsh_to_slark' && input.remaining !== 'slark_to_dsh')) return invalid()
      return { state: input.state, remaining: input.remaining, label }
    }
    case 'candidates':
      return parseBindingTargetPage(input)
    case 'preview': {
      record(input, ['state', 'proposalRef', 'label', 'kind', 'action', 'display'])
      const label = positive(input.label)
      if (label > 999_999_999) return invalid()
      return { state: input.state, proposalRef: opaque(input.proposalRef), label, ...bindingAction(input.kind, input.action),
        display: parseBindingPreviewDisplay(input.display) }
    }
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
  const field = { send: 'content', read: 'receipt', binding_receipt: 'receipt', binding_intent: 'intent', binding_confirmation: 'confirmation',
    binding_propose: 'proposal', binding_targets: 'lookup' } as const
  if (op !== 'read' && op !== 'send' && op !== 'binding_intent' && op !== 'binding_receipt' && op !== 'binding_confirmation' &&
      op !== 'binding_propose' && op !== 'binding_targets') return invalid()
  record(fields, ['operation', 'ticket', 'botId', 'sessionId', 'callId', 'rootCallId', 'sourceMessageId',
    field[op]])
  const base = { ticket: opaque(fields.ticket), botId: id(fields.botId), sessionId: id(fields.sessionId),
    callId: id(fields.callId), rootCallId: id(fields.rootCallId), sourceMessageId: id(fields.sourceMessageId) }
  if (op !== 'read' && op !== 'send' && base.callId !== base.rootCallId) return invalid()
  if (op === 'binding_intent') {
    return { request: { ...base, operation: op, intent: parseHostBindingWorkerEvidence(fields.intent) } }
  }
  if (op === 'binding_confirmation') {
    return { request: { ...base, operation: op, confirmation: parseBindingConfirmation(fields.confirmation) } }
  }
  if (op === 'binding_propose') {
    return { request: { ...base, operation: op, proposal: parseBindingProposal(fields.proposal) } }
  }
  if (op === 'binding_targets') return { request: { ...base, operation: op, lookup: parseBindingTargetLookup(fields.lookup) } }
  return { request: op === 'send'
    ? { ...base, operation: op, content: text(fields.content, maxQuestionBytes) }
    : { ...base, operation: op, receipt: opaque(fields.receipt) } }
}
