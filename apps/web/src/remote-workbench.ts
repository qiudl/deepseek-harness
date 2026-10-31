/** Native input capabilities are available only through the authenticated parent port. */
import type { TunnelFetch } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
import { exchange, readJson } from './remote-response.ts'

class NativeWorkbenchFailure extends Error {
  constructor(readonly code: 'unavailable' | 'invalid' | 'conflict') { super(`native_workbench_${code}`) }
}
function row(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return row(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function session(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u.test(value)
}
/** Install advertised native Duet and draft operations before shared UI plugins activate.
 * @param fetch Request carrier fixed to the verified parent port.
 * @returns Completion after discovery; an unsupported parent installs no native controls.
 */
export async function installRemoteWorkbench(fetch: TunnelFetch): Promise<void> {
  const lifetime = new AbortController()
  let installed: object | undefined
  const onHide = (): void => {
    lifetime.abort()
    if (installed && Reflect.get(window, '__DSH_NATIVE_WORKBENCH__') === installed) Reflect.deleteProperty(window, '__DSH_NATIVE_WORKBENCH__')
    window.removeEventListener('pagehide', onHide)
  }
  window.addEventListener('pagehide', onHide, { once: true })
  const request = async (path: string, input?: object, caller?: AbortSignal): Promise<unknown> => {
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort() }, path === '/__native_dictation__' ? 75_000 : input ? 60_000 : 5000)
    const signal = AbortSignal.any([lifetime.signal, timeout.signal, ...(caller ? [caller] : [])])
    try {
      signal.throwIfAborted()
      const body = input && JSON.stringify(input)
      if (body && new TextEncoder().encode(body).length > 65_536) throw new NativeWorkbenchFailure('invalid')
      const response = await exchange(fetch, path, body === undefined ? { method: 'GET' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body }, signal)
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        throw new NativeWorkbenchFailure(response.status === 409 ? 'conflict' : 'unavailable')
      }
      return await readJson(response, signal, 65_536)
    } finally { clearTimeout(timer) }
  }
  try {
    let capabilities: unknown
    try { capabilities = await request('/__native_workbench__') } catch { return }
    if (!row(capabilities) || Object.keys(capabilities).some(key => !['schema', 'duet', 'draft', 'personalInbox', 'botPending', 'dictation'].includes(key))
      || capabilities.schema !== 'dsh-native-workbench/v1'
      || typeof capabilities.duet !== 'boolean' || typeof capabilities.draft !== 'boolean'
      || ['personalInbox', 'botPending', 'dictation'].some(key => key in capabilities && typeof capabilities[key] !== 'boolean')
      || lifetime.signal.aborted) return
    if (Reflect.get(window, '__DSH_NATIVE_WORKBENCH__') !== undefined) throw new NativeWorkbenchFailure('invalid')
    const bridge = {
      ...(capabilities.dictation === true ? {
        async dictate(sessionId: string, signal: AbortSignal): Promise<string | null> {
          if (!session(sessionId)) throw new NativeWorkbenchFailure('invalid')
          const result = await request('/__native_dictation__', { sessionId }, signal)
          if (!exact(result, ['ok', 'value']) || result.ok !== true || !exact(result.value, ['text']) ||
            result.value.text !== null && (typeof result.value.text !== 'string' || new TextEncoder().encode(result.value.text).length > 16_384))
            throw new NativeWorkbenchFailure('unavailable')
          return result.value.text
        },
      } : {}),
      ...(capabilities.duet ? {
        async duetStart(sessionId: string): Promise<void> {
          if (!session(sessionId)) throw new NativeWorkbenchFailure('invalid')
          const result = await request('/__native_duet__', { sessionId })
          if (!exact(result, ['ok', 'value']) || result.ok !== true || !exact(result.value, ['accepted'])
            || result.value.accepted !== true) throw new NativeWorkbenchFailure('unavailable')
        },
      } : {}),
      ...(capabilities.draft ? {
        async conversationDraft(input: unknown): Promise<unknown> {
          if (!row(input) || !session(input.sessionId) || (input.action === 'read'
            ? !exact(input, ['action', 'sessionId']) : input.action !== 'write' || !exact(input, ['action', 'sessionId', 'revision', 'text'])
              || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || typeof input.text !== 'string')) {
            throw new NativeWorkbenchFailure('invalid')
          }
          const result = await request('/__native_draft__', input)
          if (!exact(result, ['ok', 'value']) || result.ok !== true || !exact(result.value, ['revision', 'text'])
            || !Number.isSafeInteger(result.value.revision) || Number(result.value.revision) < 0
            || typeof result.value.text !== 'string') throw new NativeWorkbenchFailure('unavailable')
          return result
        },
      } : {}),
    }
    Reflect.set(window, '__DSH_NATIVE_WORKBENCH__', bridge)
    installed = bridge
  } finally { if (!installed) window.removeEventListener('pagehide', onHide) }
}
