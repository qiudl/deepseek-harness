/** Original-chat execution methods carried only by the authenticated Slark parent MessagePort. */
interface Transport {
  readonly signal: AbortSignal
  call(method: string, request: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}
const coordinates = ['workspace_id', 'session_id', 'source_message_id', 'source_revision']
const encoder = new TextEncoder()
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length) throw Error('invalid collaboration data')
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(fields).length !== keys.length || keys.some(key => !fields[key]?.enumerable
    || !Object.hasOwn(fields[key], 'value'))) throw Error('invalid collaboration fields')
  return value as Record<string, unknown>
}
function id(value: unknown): boolean {
  return typeof value === 'string' && /^[!-~]{1,256}$/u.test(value) && !/[/\\]/u.test(value)
    && value !== '.' && value !== '..'
}
function version(value: unknown): boolean {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value)
    && BigInt(value) <= 9223372036854775807n
}
function text(value: unknown, limit: number): boolean {
  return typeof value === 'string' && encoder.encode(value).length <= limit && !/\p{Surrogate}/u.test(value)
}
function source(value: unknown): Record<string, unknown> {
  const row = exact(value, coordinates)
  if (!id(row.session_id) || !id(row.source_message_id) || !version(row.source_revision)
    || typeof row.workspace_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(row.workspace_id)) {
    throw Error('invalid collaboration source')
  }
  return row
}
function sameSource(value: unknown, original: Record<string, unknown>): void {
  const row = source(value)
  if (coordinates.some(key => row[key] !== original[key])) throw Error('changed collaboration source')
}
function capture(method: string, raw: unknown): { request: Record<string, unknown>; original: Record<string, unknown> } {
  const keys = method === 'submit' ? [...coordinates, 'original_message', 'active_mentions']
    : method === 'pending' ? ['source'] : ['source', ...(raw !== null && typeof raw === 'object'
      && Object.hasOwn(raw, 'limit') ? ['limit'] : []), ...(raw !== null && typeof raw === 'object'
      && Object.hasOwn(raw, 'after_delivery_id') ? ['after_delivery_id'] : [])]
  const row = exact(raw, keys)
  const original = method === 'submit' ? source(Object.fromEntries(coordinates.map(key => [key, row[key]])))
    : source(row.source)
  if (method === 'submit') {
    if (!text(row.original_message, 32 * 1024) || typeof row.original_message !== 'string'
      || !row.original_message.trim() || !Array.isArray(row.active_mentions)
      || !row.active_mentions.length || row.active_mentions.length > 10) throw Error('invalid original message')
    const ids = new Set<unknown>(), ranges: Array<{ start: number; end: number }> = []
    for (const value of row.active_mentions) {
      const mention = exact(value, ['mention_id', 'source_span', 'display_snapshot', 'binding'])
      const span = exact(mention.source_span, ['source_message_id', 'source_revision', 'start', 'end'])
      const names = exact(mention.display_snapshot, ['agent_name', 'project_name'])
      const binding = exact(mention.binding, ['kind', 'target', 'capability_snapshot'])
      const target = exact(binding.target, ['project_id', 'agent_id'])
      if (!id(mention.mention_id) || ids.has(mention.mention_id)
        || span.source_message_id !== original.source_message_id || span.source_revision !== original.source_revision
        || typeof span.start !== 'number' || typeof span.end !== 'number'
        || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
        || span.start < 0 || span.end <= span.start + 1 || span.end > row.original_message.length
        || row.original_message[span.start] !== '@' || !text(names.agent_name, 512) || !names.agent_name
        || (names.project_name !== null && !text(names.project_name, 512)) || binding.kind !== 'resolved'
        || !id(target.project_id) || !id(target.agent_id) || typeof binding.capability_snapshot !== 'string'
        || !/^[a-f0-9]{64}$/u.test(binding.capability_snapshot)) throw Error('invalid explicit mention')
      ids.add(mention.mention_id); ranges.push({ start: span.start, end: span.end })
    }
    ranges.sort((a, b) => a.start - b.start)
    if (ranges.some((range, index) => index > 0 && range.start < (ranges[index - 1]?.end ?? 0))) {
      throw Error('overlapping explicit mentions')
    }
  } else if (method === 'deliveries') {
    if (Object.hasOwn(row, 'limit') && (!Number.isSafeInteger(row.limit)
      || Number(row.limit) < 1 || Number(row.limit) > 50)) throw Error('invalid result limit')
    if (Object.hasOwn(row, 'after_delivery_id') && !id(row.after_delivery_id)) throw Error('invalid result cursor')
  }
  const json = JSON.stringify(row)
  if (encoder.encode(json).length > 32 * 1024) throw Error('request too large')
  const request = JSON.parse(json) as Record<string, unknown>
  return { request, original: method === 'submit'
    ? Object.fromEntries(coordinates.map(key => [key, request[key]])) : source(request.source) }
}
function result(method: string, value: unknown, original: Record<string, unknown>): unknown {
  if (value === null || typeof value !== 'object') throw Error('invalid collaboration result')
  const refusal = Reflect.get(value, 'ok') === false
  const row = exact(value, refusal ? ['ok', 'errorCode', ...(method === 'submit' ? ['reconciliationRequired'] : [])]
    : ['ok', 'value'])
  if (refusal) {
    if (typeof row.errorCode !== 'string' || !/^[a-z][a-z0-9_:-]{0,127}$/u.test(row.errorCode)
      || (method === 'submit' && typeof row.reconciliationRequired !== 'boolean')) throw Error('invalid refusal')
    return row
  }
  if (row.ok !== true || row.value === null || typeof row.value !== 'object') throw Error('invalid success')
  if (method === 'submit') {
    const accepted = exact(row.value, ['source', 'submission_state',
      ...(Object.hasOwn(row.value, 'invocation_id') ? ['invocation_id'] : [])])
    sameSource(accepted.source, original)
    if (accepted.submission_state !== 'accepted'
      || (Object.hasOwn(accepted, 'invocation_id') && !id(accepted.invocation_id))) throw Error('invalid acceptance')
  } else if (method === 'pending') {
    const page = exact(row.value, ['source', 'plan', 'pending_items', 'frozen_task_count'])
    sameSource(page.source, original)
    if (!Array.isArray(page.pending_items) || page.pending_items.length > 10
      || !Number.isSafeInteger(page.frozen_task_count) || Number(page.frozen_task_count) < 0
      || Number(page.frozen_task_count) + page.pending_items.length > 10) throw Error('invalid pending page')
  } else {
    const page = exact(row.value, ['deliveries', ...(Object.hasOwn(row.value, 'next_cursor') ? ['next_cursor'] : [])])
    if (!Array.isArray(page.deliveries) || page.deliveries.length > 50
      || (Object.hasOwn(page, 'next_cursor') && !id(page.next_cursor))) throw Error('invalid delivery page')
    for (const item of page.deliveries) {
      if (item === null || typeof item !== 'object') throw Error('invalid delivery')
      sameSource(Reflect.get(item, 'source_locator'), original)
    }
  }
  return row
}

/**
 * Build the complete execution consumer after parent capability discovery; scope-only parents expose none of these methods.
 * @param transport - Authenticated parent unary calls and the owning page lifetime; no network or credentials.
 * @returns Original Source submission and bounded pending/delivery reads; cancellation preserves submission uncertainty.
 */
export function createRemoteCollaborationExecution(transport: Transport) {
  const call = async (method: string, raw: unknown): Promise<unknown> => {
    const deadline = new AbortController(), timer = setTimeout(() => { deadline.abort() }, 38_000)
    const signal = AbortSignal.any([deadline.signal, transport.signal])
    let sent = false
    try {
      const { request, original } = capture(method, raw)
      signal.throwIfAborted(); sent = true
      const value = await transport.call('collaboration/' + method, request, signal)
      signal.throwIfAborted()
      return result(method, value, original)
    } catch {
      return { ok: false, errorCode: method === 'submit'
        ? 'collaboration_submission_unavailable' : 'collaboration_result_unavailable',
      ...(method === 'submit' ? { reconciliationRequired: sent } : {}) }
    } finally { clearTimeout(timer) }
  }
  return {
    collaborationSubmit: async (value: unknown): Promise<unknown> => call('submit', value),
    collaborationPending: async (value: unknown): Promise<unknown> => call('pending', value),
    collaborationDeliveries: async (value: unknown): Promise<unknown> => call('deliveries', value),
  }
}
