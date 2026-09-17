// Optional Desktop Host attachment Save As capability. Browser deployments do
// not synthesize a download fallback: their ordinary download policy remains
// independent, and Desktop continues to deny generic renderer downloads.

export interface DesktopAttachmentSaveInput {
  readonly sessionId: string
  readonly refType: 'image' | 'file'
  readonly attachmentId: string
  readonly name: string
}

export type DesktopAttachmentSaveOutcome = 'saved' | 'cancelled' | 'unsupported' | 'failed'
export interface DesktopAttachmentSaveProgress {
  readonly receivedBytes: number
  readonly totalBytes: number
}

/** Whether the isolated page received the narrow Desktop attachment capability. */
export function desktopAttachmentSaveAvailable(): boolean {
  return desktopAttachmentHost() !== undefined
}

/** Request one identity-bound native Save As operation when Desktop advertises it. */
export async function saveDesktopAttachment(
  input: DesktopAttachmentSaveInput,
  onProgress?: (progress: DesktopAttachmentSaveProgress) => void,
): Promise<DesktopAttachmentSaveOutcome> {
  const host = desktopAttachmentHost()
  if (host === undefined) return 'unsupported'
  try {
    const hello = await host.hello()
    if (hello.protocol !== 1 || !hello.ok || !hello.features?.includes('attachment-save-v1')) {
      return 'unsupported'
    }
    const result = await host.saveAttachment(
      { ...input, name: input.name.normalize('NFC') },
      onProgress,
    )
    if (result.protocol !== 1 || !result.ok) return 'failed'
    return result.outcome === 'cancelled' ? 'cancelled' : result.outcome === 'saved' ? 'saved' : 'failed'
  } catch {
    return 'failed'
  }
}

/** Cancel the single in-flight native Save As operation owned by this DSH view. */
export async function cancelDesktopAttachmentSave(): Promise<boolean> {
  const host = desktopAttachmentHost()
  if (host === undefined) return false
  try {
    const result = await host.cancelAttachmentSave()
    return result.protocol === 1 && result.ok
  } catch {
    return false
  }
}

interface DesktopHostResponse {
  readonly ok: boolean
  readonly protocol: number
  readonly features?: readonly string[]
  readonly outcome?: 'saved' | 'cancelled'
}

interface DesktopAttachmentHost {
  readonly hello: () => Promise<DesktopHostResponse>
  readonly saveAttachment: (
    input: DesktopAttachmentSaveInput,
    onProgress?: (progress: DesktopAttachmentSaveProgress) => void,
  ) => Promise<DesktopHostResponse>
  readonly cancelAttachmentSave: () => Promise<DesktopHostResponse>
}

function desktopAttachmentHost(): DesktopAttachmentHost | undefined {
  const candidate = Reflect.get(globalThis, '__DSH_DESKTOP_HOST__') as unknown
  if (!candidate || typeof candidate !== 'object') return undefined
  const value = candidate as Partial<DesktopAttachmentHost>
  return typeof value.hello === 'function' && typeof value.saveAttachment === 'function'
    && typeof value.cancelAttachmentSave === 'function'
    ? value as DesktopAttachmentHost
    : undefined
}
