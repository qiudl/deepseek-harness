/** Preserve operation correlation across adapter transports without treating it as authority.
 * @param headers - Existing deployment and authentication headers.
 * @param traceparent - Optional W3C correlation from the operation owner.
 * @returns Fresh headers with validated correlation replacing static collisions.
 */
export function requestTraceHeaders(
  headers: Readonly<Record<string, string>> | undefined,
  traceparent: string | undefined,
): Record<string, string> {
  if (traceparent === undefined) return { ...headers }
  if (/^00-(?!0{32})[a-f0-9]{32}-(?!0{16})[a-f0-9]{16}-01$/u.exec(traceparent)?.[0] !== traceparent)
    throw Error('invalid_request_traceparent')
  return { ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== 'traceparent')), traceparent }
}

const operationTraces = new WeakMap<object, string>()
/** Attach correlation to a frozen request without changing model input or authorization.
 * @param request - Exact request object at the LLM middleware boundary.
 * @param traceparent - Persisted W3C identity from the owning operation.
 */
export function bindRequestTrace(request: object, traceparent: string): void {
  requestTraceHeaders(undefined, traceparent)
  const existing = operationTraces.get(request)
  if (existing !== undefined && existing !== traceparent) throw Error('request_trace_binding_conflict')
  operationTraces.set(request, traceparent)
}
/** Read operation-local correlation at the final adapter boundary.
 * @param request - Exact immutable middleware request.
 * @returns Bound correlation if its owner supplied one.
 */
export function boundRequestTrace(request: object): string | undefined {
  return operationTraces.get(request)
}
