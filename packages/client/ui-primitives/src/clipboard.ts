// Host clipboard write shared by Web UI copy controls. Success feedback stays
// with each control; this helper only reports whether the host accepted a write.

/**
 * Write text to the host clipboard, preferring the versioned Desktop bridge,
 * then the async Clipboard API, and finally `execCommand('copy')` on hosts
 * (jsdom, insecure contexts) that omit it.
 * @param text - the exact text to place on the clipboard.
 * @returns true only when the host accepted the write.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  const desktop = desktopClipboardHost()
  if (desktop !== undefined) {
    try {
      const hello = await desktop.hello()
      if (hello.protocol !== 1 || !hello.ok || !hello.features?.includes('clipboard-write-v1')) {
        return false
      }
      const result = await desktop.writeClipboard(text)
      return result.protocol === 1 && result.ok
    } catch {
      return false
    }
  }
  // lib.dom types clipboard non-optional, but insecure contexts omit it —
  // that runtime gap is exactly what this guard detects.
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Denied permissions / iframe policy — do not claim success.
      return false
    }
  }
  // jsdom and older hosts: best-effort execCommand path when present.
  // execCommand('copy') is the only clipboard fallback where the async API
  // is missing; deprecated but deliberately retained.
  /* oxlint-disable typescript/no-deprecated */
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
  }
  /* oxlint-enable typescript/no-deprecated */
}

interface DesktopHostResponse {
  readonly ok: boolean
  readonly protocol: number
  readonly features?: readonly string[]
}

interface DesktopClipboardHost {
  readonly hello: () => Promise<DesktopHostResponse>
  readonly writeClipboard: (text: string) => Promise<DesktopHostResponse>
}

function desktopClipboardHost(): DesktopClipboardHost | undefined {
  const candidate = Reflect.get(globalThis, '__DSH_DESKTOP_HOST__') as unknown
  if (!candidate || typeof candidate !== 'object') return undefined
  const value = candidate as Partial<DesktopClipboardHost>
  return typeof value.hello === 'function' && typeof value.writeClipboard === 'function'
    ? value as DesktopClipboardHost
    : undefined
}
