/** Account and original-worker checks for one guarded native preparation phase. */
import { matchHostNativeRoomPreparationWorkerRead, parseHostNativeRoomPreparationWorkerRead,
  type HostNativeRoomPreparationTarget, type HostNativeRoomPreparationWorkerRead } from '@deepseek-ai/dsh-host-control-protocol'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import type { DesktopHost } from './desktop-host.ts'
import type { ProfileWorkerSupervisor } from './worker-supervisor.ts'
import { HostAuthorityError } from './types.ts'

/** Check the independent nonce lifetime and the original nested challenge lifetime.
 * @param target Parsed original stage.
 * @param now Host clock in milliseconds.
 */
export function assertNativePreparationCurrent(target: HostNativeRoomPreparationTarget, now: number): void {
  if (target.expires_at <= now || target.expires_at - now > 60_000) throw new HostAuthorityError('stale')
  const challenge = target.operation === 'attest_source' ? target.source_challenge
    : target.operation === 'attest_activation' ? target.activation_challenge : undefined
  if (challenge && (challenge.expires_at <= now || challenge.expires_at - now > 300_000))
    throw new HostAuthorityError('stale')
}

/** Read one phase only from the exact current Account Profile and recheck before signing.
 * @param host Current Host Account grants.
 * @param workers Current Profile worker selector; no old preparation fallback.
 * @param account Authenticated caller Account and owner.
 * @param target Complete original stage and binding selectors.
 * @param signal Caller cancellation.
 * @param clock Host clock used before and after worker I/O.
 * @returns Actual Profile, unsigned observations, and the guard required synchronously before signing and publication.
 */
export async function readAccountNativeRoomPreparation(
  host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
  workers: Pick<ProfileWorkerSupervisor, 'nativeRoomPreparationReceiver'>, account: BotIdentityAccount,
  target: HostNativeRoomPreparationTarget, signal: AbortSignal, clock: () => number,
): Promise<{ profileId: string; value: HostNativeRoomPreparationWorkerRead; assertCurrent(): void }> {
  if (!account.ownerId) throw new HostAuthorityError('unauthorized')
  const challenge = target.operation === 'attest_source' ? target.source_challenge
    : target.operation === 'attest_activation' ? target.activation_challenge : undefined
  if (challenge && (challenge.environment_id !== account.authorityEnvironmentId ||
    challenge.account_issuer !== account.issuer || challenge.account_subject !== account.subject ||
    challenge.audience !== target.slark_audience)) throw new HostAuthorityError('profile_mismatch')
  const current = () => {
    signal.throwIfAborted()
    assertNativePreparationCurrent(target, clock())
    host.authorizeCollaborationRegistration(account)
    const profile: string = host.authorizeAccountModelText(account)
    if (profile !== target.expected_profile_id) throw new HostAuthorityError('profile_mismatch')
    return profile
  }
  const profileId = current()
  const receiver = workers.nativeRoomPreparationReceiver(profileId)
  const assertCurrent = () => { current(); receiver.assertCurrent() }
  assertCurrent()
  const read = await receiver.read(target, signal)
  assertCurrent()
  const value = matchHostNativeRoomPreparationWorkerRead(parseHostNativeRoomPreparationWorkerRead(read), target)
  if (value.state === 'upgrade_required') throw new HostAuthorityError('upgrade_required')
  return { profileId, value, assertCurrent }
}
