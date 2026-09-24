/** Isolated static-page carrier for a Slark parent that has authenticated Host assets. */
import { WorkerTunnel, type TunnelEndpoint } from '@deepseek-ai/dsh-experimental-webworker-runtime/client'

const schema = 'dsh-remote-frame/v1'
const expectedOrigin = import.meta.env.VITE_DSH_REMOTE_PARENT_ORIGIN
const gate = Promise.withResolvers<void>()
;(globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__ = gate
void gate.promise.catch(() => {})

function parentOrigin(): string {
  if (typeof expectedOrigin !== 'string' || expectedOrigin.length === 0) {
    throw new Error('remote web: parent origin is not configured')
  }
  const origin = new URL(expectedOrigin).origin
  if (origin !== expectedOrigin || !origin.startsWith('https://')) {
    throw new Error('remote web: parent origin must be an exact HTTPS origin')
  }
  if (window.parent === window) throw new Error('remote web: parent frame is required')
  return origin
}

function portEndpoint(port: MessagePort): TunnelEndpoint {
  return {
    postMessage(message, transfer) { port.postMessage(message, transfer ?? []) },
    addEventListener(type, listener) {
      if (type === 'message') port.addEventListener('message', listener as EventListener)
      else port.addEventListener('messageerror', () => {
        ;(listener as (event: ErrorEvent) => void)(new ErrorEvent('error', { message: 'remote frame port failed' }))
      })
    },
  }
}

async function connect(): Promise<WorkerTunnel> {
  const origin = parentOrigin()
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const connected = Promise.withResolvers<MessagePort>()
  const timer = setTimeout(() => { connected.reject(new Error('remote web: parent connection timed out')) }, 30_000)
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== window.parent || event.origin !== origin) return
    const data = event.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return
    const row = data as Record<string, unknown>
    if (row.schema !== schema || row.kind !== 'connect' || row.nonce !== nonce ||
        event.ports.length !== 1) return
    const port = event.ports[0]
    if (port === undefined) return
    window.removeEventListener('message', onMessage)
    connected.resolve(port)
  }
  window.addEventListener('message', onMessage)
  window.parent.postMessage({ schema, kind: 'ready', nonce }, origin)
  try {
    const port = await connected.promise
    port.start()
    return new WorkerTunnel(portEndpoint(port))
  } finally {
    clearTimeout(timer)
    window.removeEventListener('message', onMessage)
  }
}

const tunnel = connect()
void tunnel.catch(() => {})
;(globalThis as { dshRemoteBoot?: unknown }).dshRemoteBoot = {
  async ready() {
    const carrier = await tunnel
    const payload = await carrier.bootPayload()
    return {
      injections: payload.injections,
      transport: {
        fetch: carrier.fetch,
        openStream: carrier.open.bind(carrier),
        loadBundle: carrier.loadBundle.bind(carrier),
      },
    }
  },
}
