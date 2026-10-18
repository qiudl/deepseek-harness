/** REQ-20261013-0021 / 24205. Bounded, connection-owned package assembly.
 * A complete upload only prepares a package; a separate current grant and
 * Server authorization must precede activation.
 */
import { createHash } from 'node:crypto'
import type { SkillHubPackagePlan } from './skillhub-package-install.ts'

const MAX_ARCHIVE = 110 * 1024 * 1024
const MAX_CHUNK = 32 * 1024
const IDLE_MS = 300_000
const fail = (): never => { throw Error('skillhub_package_upload_unavailable') }

interface Receiver {
  assertCurrent(): void
  prepare(plan: SkillHubPackagePlan, archive: Buffer): Promise<void>
}
interface Upload {
  readonly ownerId: string
  readonly bindingKey: string
  readonly planJson: string
  readonly plan: SkillHubPackagePlan
  readonly totalBytes: number
  readonly signal: AbortSignal
  readonly receiver: Receiver
  readonly onAbort: () => void
  timer: NodeJS.Timeout
  readonly parts: Buffer[]
  offset: number
  lastOffset: number
  lastPart: Buffer | null
  preparing: boolean
  expired: boolean
}

/** One active upload across all Host control connections bounds retained bytes. */
export class SkillHubPackageUploads {
  private upload: Upload | null = null

  /** Accept a sequential fragment under the same connection-owned Profile grant.
   * @param input - fixed plan, grant fence, bounded fragment, and current receiver.
   * @returns the next byte offset and whether the complete archive was prepared.
   */
  async accept(input: {
    readonly ownerId: string
    readonly bindingKey: string
    readonly plan: SkillHubPackagePlan
    readonly totalBytes: number
    readonly offset: number
    readonly bytes: Buffer
    readonly signal: AbortSignal
    readonly authorize: () => void
    readonly capture: () => Receiver
  }): Promise<Readonly<{ nextOffset: number; prepared: boolean }>> {
    try { input.signal.throwIfAborted(); input.authorize() }
    catch (error) {
      const active = this.upload
      if (active?.signal === input.signal) { active.expired = true; this.release(active) }
      throw error
    }
    if (!Number.isSafeInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > MAX_ARCHIVE
      || !Number.isSafeInteger(input.offset) || input.offset < 0
      || !Buffer.isBuffer(input.bytes) || input.bytes.length < 1 || input.bytes.length > MAX_CHUNK)
      fail()
    const planJson = JSON.stringify(input.plan)
    let upload = this.upload
    if (!upload) {
      if (input.offset !== 0 || !input.ownerId || !input.bindingKey || !input.plan.operationId) fail()
      const receiver = input.capture()
      receiver.assertCurrent()
      const plan = structuredClone(input.plan)
      const onAbort = () => { created.expired = true; this.release(created) }
      const timer = setTimeout(onAbort, IDLE_MS)
      timer.unref()
      const created: Upload = {
        ownerId: input.ownerId, bindingKey: input.bindingKey, planJson,
        plan, totalBytes: input.totalBytes,
        signal: input.signal, receiver, onAbort, timer, parts: [], offset: 0,
        lastOffset: -1, lastPart: null, preparing: false, expired: false,
      }
      upload = created
      this.upload = upload
      input.signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      if (upload.preparing || upload.expired || upload.signal !== input.signal || upload.signal.aborted
        || upload.ownerId !== input.ownerId || upload.bindingKey !== input.bindingKey
        || upload.planJson !== planJson || upload.totalBytes !== input.totalBytes) fail()
      upload.receiver.assertCurrent()
      if (input.offset === upload.lastOffset && upload.lastPart?.equals(input.bytes))
        return { nextOffset: upload.offset, prepared: false }
      if (input.offset !== upload.offset || input.offset + input.bytes.length > upload.totalBytes) fail()
      const part = Buffer.from(input.bytes)
      upload.parts.push(part)
      upload.lastOffset = input.offset
      upload.lastPart = part
      upload.offset += part.length
      clearTimeout(upload.timer)
      upload.timer = setTimeout(upload.onAbort, IDLE_MS)
      upload.timer.unref()
      if (upload.offset < upload.totalBytes) return { nextOffset: upload.offset, prepared: false }
      upload.preparing = true
      const archive = Buffer.concat(upload.parts, upload.totalBytes)
      if (createHash('sha256').update(archive).digest('hex') !== upload.plan.archiveSha256) fail()
      if (upload.expired) fail()
      input.authorize(); upload.receiver.assertCurrent(); upload.signal.throwIfAborted()
      await upload.receiver.prepare(upload.plan, archive)
      if (upload.expired) fail()
      input.authorize(); upload.receiver.assertCurrent(); upload.signal.throwIfAborted()
      return { nextOffset: upload.offset, prepared: true }
    } catch (error) {
      if (upload.signal === input.signal) {
        upload.expired = true
        this.release(upload)
      }
      throw error
    } finally {
      if (upload.preparing && upload.signal === input.signal) this.release(upload)
    }
  }

  private release(upload: Upload): void {
    if (this.upload !== upload) return
    this.upload = null
    clearTimeout(upload.timer)
    upload.signal.removeEventListener('abort', upload.onAbort)
    upload.parts.length = 0
  }
}
