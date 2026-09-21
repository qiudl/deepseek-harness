/** Narrow Slark Desktop capability used only to reveal the original Desktop Hub. */

export interface ExtensionBridgeError {
  readonly code: string
  readonly message: string
}

export type ExtensionBridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExtensionBridgeError }

export interface DesktopExtensionBridge {
  /** Prove that this renderer belongs to the active DSH Profile. */
  readonly hello: () => Promise<ExtensionBridgeResult<{ readonly protocol: number }>>
  /** Ask Desktop Main to place the original Hub in DSH's content column. */
  readonly showHub: () => Promise<ExtensionBridgeResult<Record<string, never>>>
}

declare global {
  interface Window {
    /** Installed only by Slark's isolated DSH Profile preload. */
    __SLARK_DSH_EXTENSIONS__?: DesktopExtensionBridge
  }
}

/** Resolve only the two capabilities needed by the navigation entry. */
export function desktopExtensionBridge(): DesktopExtensionBridge | undefined {
  const candidate = window.__SLARK_DSH_EXTENSIONS__
  if (candidate === undefined) return undefined
  if (typeof candidate.hello !== 'function' || typeof candidate.showHub !== 'function') return undefined
  return candidate
}
