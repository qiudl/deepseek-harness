/** Current reverse admission and metadata-only historical settlement; no producer token or model consumer is minted. */
import { parseHostBotIdentity } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostProjectMemoryRequest, HostProjectMemoryCommands } from '@deepseek-ai/dsh-host-control-protocol'
import type { AccountProjectOperationMemoryOptions } from './account-project-operation-memory.ts'
import { HostAuthorityError } from './types.ts'

/** Dispatch only the existing reverse apply/receipt operations after the shared current Account/peer checks.
 * @param options - Actual Host-owned recipient factory and worker identity reader.
 * @param profileId - Current Account-authorized Profile, never derived from the remote source.
 * @param request - Closed current signed request.
 * @param signal - Current connection cancellation.
 * @param guard - Live Account/Profile/current directive deadline fence.
 * @returns Original metadata result, or explicit absence; no historical fact creates a current reader.
 */
export async function operateAccountProjectOperationMemoryRecipient(
  options: AccountProjectOperationMemoryOptions,
  profileId: string,
  request: HostProjectMemoryRequest,
  signal: AbortSignal,
  guard: () => void,
) {
  const d = request.directive
  if (d.direction !== 'slark_to_dsh' || d.scope.sourceRef.side !== 'slark' || d.scope.recipientRef.side !== 'dsh' ||
      (d.operation !== 'apply' && d.operation !== 'receipt')) return { status: 'error', code: 'capability_unavailable', requestId: d.requestId, retryable: false } as const
  guard()
  const factory = options.recipientImports
  const store = await factory?.(profileId)
  guard()
  if (options.recipientImports !== factory || !store) throw new HostAuthorityError('unavailable')
  if (store.profileId !== profileId) throw new HostAuthorityError('profile_mismatch')
  store.reserveNonce(d, options.now(), guard)
  if (d.operation === 'receipt') return store.read(d, request.commandBody as HostProjectMemoryCommands['receipt'])
  const c = request.commandBody as HostProjectMemoryCommands['apply']
  if (c.phase === 'finalize' && c.cloudMaterialReceipt.stage === 'reconciliation_only')
    return store.finalize(d, c, options.now(), guard)
  const confirmation = c.phase === 'stage' ? store.originalConfirmation(d) : store.deliveryConfirmation(d, c)
  const resolve = options.resolveRecipientBot
  if (!confirmation || !resolve) throw new HostAuthorityError('unavailable')
  const botId = confirmation.ack.botId
  guard()
  const identity = parseHostBotIdentity(await resolve(profileId, botId, signal))
  guard()
  if (options.resolveRecipientBot !== resolve || !identity || identity.bot_id !== botId ||
      identity.actor_ref !== d.scope.recipientRef.botRef) throw new HostAuthorityError('unauthorized')
  return c.phase === 'stage' ? store.stage(d, c, confirmation, options.now, options.sign, guard)
    : store.finalize(d, c, options.now(), guard)
}
