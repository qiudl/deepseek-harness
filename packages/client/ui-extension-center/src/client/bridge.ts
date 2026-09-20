/** Narrow Desktop capability consumed by the DSH-native Extension Center. */

export type ExtensionKind = 'plugin' | 'mcp' | 'skill'

export interface ExtensionProfile {
  /** Opaque stable key used only to scope local presentation preferences. */
  readonly key: string
  /** Host-supplied display label; never interpreted as an authority token. */
  readonly label: string
}

export interface ExtensionEntry {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly enabled?: boolean
}

export interface ExtensionBridgeError {
  readonly code: string
  readonly message: string
}

export type ExtensionBridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExtensionBridgeError }

export interface DesktopExtensionBridge {
  /** Prove that this renderer is the active DSH Profile view. */
  readonly hello: () => Promise<ExtensionBridgeResult<{
    readonly protocol: 1
    readonly profile: ExtensionProfile
  }>>
  /** Read a bounded inventory for one extension kind. */
  readonly list: (kind: ExtensionKind) => Promise<ExtensionBridgeResult<{
    readonly entries: readonly ExtensionEntry[]
  }>>
  /** Prepare a Profile-bound transaction without package-manager writes. */
  readonly prepare: (kind: ExtensionKind, payload: string) => Promise<ExtensionBridgeResult<{
    readonly planId: string
    readonly digest: string
    readonly expiresAt: number
    readonly scripts?: readonly { readonly name: string; readonly command: string }[]
    readonly scriptDigest?: string
  }>>
  /** Confirm one prepared plan; scriptDigest is present only after explicit script review. */
  readonly commit: (planId: string, scriptDigest?: string) => Promise<ExtensionBridgeResult<{
    readonly operationId: string
    readonly outcome: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'
    readonly cancellationRequested: boolean
    readonly reason?: string
  }>>
  readonly status: (operationId: string) => ReturnType<DesktopExtensionBridge['commit']>
  /** Receive Main-process menu/shortcut requests to open the same DSH page. */
  readonly onOpen: (listener: () => void) => () => void
}

declare global {
  interface Window {
    /** Installed only by Slark's isolated DSH Profile preload. */
    __SLARK_DSH_EXTENSIONS__?: DesktopExtensionBridge
  }
}

/** Resolve the capability without falling back to any general desktop API. */
export function desktopExtensionBridge(): DesktopExtensionBridge | undefined {
  const candidate = window.__SLARK_DSH_EXTENSIONS__
  if (candidate === undefined) return undefined
  if (typeof candidate.hello !== 'function'
    || typeof candidate.list !== 'function'
    || typeof candidate.prepare !== 'function'
    || typeof candidate.commit !== 'function'
    || typeof candidate.status !== 'function'
    || typeof candidate.onOpen !== 'function') return undefined
  return candidate
}
