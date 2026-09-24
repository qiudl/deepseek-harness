/** Browser entry for the Web client. */
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'
import type { ClientTransportHooks } from '@deepseek-ai/dsh-client-connection/client'

type RemoteTransport = Pick<Required<ClientTransportHooks>, 'fetch' | 'openStream' | 'loadBundle'>

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
interface RemoteBootGlobal {
  dshRemoteBoot?: {
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; transport: RemoteTransport }>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
const remote = (globalThis as RemoteBootGlobal).dshRemoteBoot
const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

try {
  if (desktop !== undefined && remote !== undefined) throw new Error('web app: multiple boot carriers')
  const el = document.getElementById('root')
  if (el === null) throw new Error('web app: missing #root')
  const entry = new AppWebEntry(el)
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
      const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
      transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => { resolve() }
        script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
        document.head.append(script)
      }))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  } else if (remote !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('remote web: boot readiness is missing')
    void remote.ready().then(async ({ injections, transport }) => {
      const { fetch, openStream, loadBundle } = transport
      if (typeof fetch !== 'function' || typeof openStream !== 'function' || typeof loadBundle !== 'function') {
        throw new Error('remote web: carrier requires fetch, openStream, and loadBundle')
      }
      ;(globalThis as { __DSH_TRANSPORT__?: ClientTransportHooks }).__DSH_TRANSPORT__ = {
        fetch, openStream, loadBundle, ownsHost: false, remoteHost: true,
      }
      await applyIndexInjections(injections, loadBundle)
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  void entry.run(desktop === undefined ? undefined : reportFailure)
} catch (reason) {
  reportFailure(reason)
}
