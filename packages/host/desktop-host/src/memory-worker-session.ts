/** REQ-20261021-0013: Host-only projection and signed query exchange with one HY worker. */
import type { HostMemorySearchItem } from './memory-evidence-index.ts'
import type { HostMemoryReadController } from './memory-read-controller.ts'
import type { MemoryWorkerChannel } from './memory-worker-channel.ts'

/** Accepted worker lease; close must wait until its child process and listener have stopped. */
export interface MemoryWorkerLink extends Pick<MemoryWorkerChannel, 'project' | 'query'> {
  close(): Promise<void>
}

/** Index identity pinned to one completed worker projection. */
export interface MemoryWorkerStamp {
  readonly indexEpoch: string
  readonly generation: number
}

/** Send every current redacted page, then recheck the index after the final acknowledgement.
 * @param controller Current Account Profile's Host-owned index controller.
 * @param openWorker Open and attest one channel using this exact index identity.
 * @param signal Cancellation of this projection.
 * @returns The channel and index identity accepted by the worker.
 */
export async function projectHostMemoryToWorker(controller: HostMemoryReadController,
  openWorker: (stamp: MemoryWorkerStamp, signal: AbortSignal) => Promise<MemoryWorkerLink>,
  signal: AbortSignal): Promise<{ readonly stamp: MemoryWorkerStamp; readonly worker: MemoryWorkerLink }> {
  let worker: MemoryWorkerLink | undefined
  try {
    await controller.warm(signal)
    let page = await controller.projectedPage(null, null, 0, signal)
    const stamp = { indexEpoch: page.indexEpoch, generation: page.generation }
    worker = await openWorker(stamp, signal)
    signal.throwIfAborted()
    for (;;) {
      await worker.project(page.items, page.nextOffset, signal)
      if (page.nextOffset === null) {
        await controller.projectedPage(stamp.indexEpoch, stamp.generation, 0, signal)
        return { stamp, worker }
      }
      page = await controller.projectedPage(stamp.indexEpoch, stamp.generation, page.nextOffset, signal)
    }
  } catch (error) {
    controller.clear()
    if (worker) await worker.close()
    throw error
  }
}

/** Resolve untrusted worker references only after consuming a current signed search directive.
 * @param controller Current Account Profile's Host-owned index controller.
 * @param worker The channel that accepted the indexed projection.
 * @param stamp Identity returned by the completed projection.
 * @param directive Fresh signed search instruction from Slark.
 * @param query Signed query text.
 * @param limit Signed maximum result count.
 * @param signal Cancellation of this search.
 * @returns Host-verified result metadata and current generation.
 */
export async function searchHostMemoryWithWorker(controller: HostMemoryReadController,
  worker: MemoryWorkerLink, stamp: MemoryWorkerStamp, directive: unknown,
  query: string, limit: number, signal: AbortSignal): Promise<{
  readonly generation: number
  readonly items: readonly HostMemorySearchItem[]
}> {
  try {
    const items = await controller.semanticSearch(directive, query, limit,
      async (text, count, requestSignal) => ({ ...stamp,
        candidates: await worker.query(text, count, requestSignal) }), signal)
    return { generation: stamp.generation, items }
  } catch (error) {
    controller.clear()
    await worker.close()
    throw error
  }
}
