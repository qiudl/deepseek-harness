/** Node preload that exits an isolated worker when its owning Host IPC channel closes.
 * This is best-effort cleanup; a durable fence is still required after an unconfirmed exit.
 */
export const RESTRICTED_WORKER_PARENT_MONITOR = `data:text/javascript,${encodeURIComponent(
  "if (!process.connected) process.exit(70); process.once('disconnect', () => process.exit(70)); process.channel?.unref()",
)}`
