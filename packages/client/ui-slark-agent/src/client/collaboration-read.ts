/** Await a view-owned collaboration read without cancelling accepted work.
 * @param promise - Existing account-bound Main read, whose settlement retains IPC ownership.
 * @param signal - View cancellation; late replies remain owned by the caller.
 * @returns The original reply, or a standard AbortError when the view is cancelled.
 */
export function awaitCollaborationRead<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { reject(new DOMException('Cancelled', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
    if (signal.aborted) abort()
  })
}
