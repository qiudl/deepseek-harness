import { parseHostBotImportGrant, verifyHostBotImportGrant } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotImportGrant } from '@deepseek-ai/dsh-host-control-protocol'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import type { BotImportSourceGrantInput } from './account-bot-import-source.ts'
import { HostAuthorityError } from './types.ts'

interface ActiveGrant {
  readonly grant: HostBotImportGrant
  readonly profileId: string
}

/** In-memory, single-Host approvals. Signed claims cannot be replayed after boot or revocation. */
export class BotImportGrantRegistry {
  private readonly active = new Map<string, ActiveGrant>()
  private readonly used = new Set<string>()

  constructor(private readonly publicKey: string, private readonly identity: {
    readonly hostInstanceId: string
    readonly processNonce: string
    readonly bootNonce: string
  }, private readonly now: () => number = Date.now) {
    const key = Buffer.from(publicKey, 'base64url')
    if (key.length !== 32 || key.toString('base64url') !== publicKey)
      throw new HostAuthorityError('invalid_input')
  }

  register(value: unknown, account: BotIdentityAccount, profileId: string): HostBotImportGrant {
    const candidate = parseHostBotImportGrant(value)
    const grant = verifyHostBotImportGrant(candidate, this.publicKey, {
      hostInstanceId: this.identity.hostInstanceId,
      processNonce: this.identity.processNonce, bootNonce: this.identity.bootNonce,
      authorityEnvironmentId: account.authorityEnvironmentId,
      accountBindingHandle: account.accountBindingHandle,
      authorityBindingVersion: account.authorityBindingVersion,
      issuer: account.issuer, subject: account.subject,
      operationId: candidate.operation_id, sourceDigest: candidate.source_digest,
      targetDeviceId: candidate.target_device_id,
    }, this.now())
    for (const [operationId, entry] of this.active)
      if (entry.grant.expires_at <= this.now()) this.active.delete(operationId)
    if (this.used.has(grant.operation_id) || this.active.size >= 8 || this.used.size >= 10_000)
      throw new HostAuthorityError('replayed')
    this.used.add(grant.operation_id)
    this.active.set(grant.operation_id, { grant, profileId })
    return grant
  }

  check(input: BotImportSourceGrantInput): void {
    input.signal.throwIfAborted()
    const entry = this.active.get(input.transfer.operationId)
    if (!entry || entry.profileId !== input.profileId ||
        entry.grant.source_digest !== input.scope.source_digest ||
        entry.grant.target_device_id !== input.scope.target_device_id ||
        !entry.grant.session_ids.includes(input.scope.session_id) ||
        entry.grant.expires_at <= this.now()) {
      if (entry?.grant.expires_at && entry.grant.expires_at <= this.now())
        this.active.delete(input.transfer.operationId)
      throw new HostAuthorityError('unauthorized')
    }
  }

  revoke(operationId: string): void {
    const entry = this.active.get(operationId)
    if (!entry) throw new HostAuthorityError('unauthorized')
    this.active.delete(operationId)
  }
}
