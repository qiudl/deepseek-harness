import { parseHostBotImportSourceRequest, parseHostBotImportSourceResult,
  parseHostBotImportSourceScope } from '@deepseek-ai/dsh-host-control-protocol'
import type { HostBotImportSourceRequest, HostBotImportSourceResult,
  HostBotImportSourceScope } from '@deepseek-ai/dsh-host-control-protocol'
import type { DesktopHost } from './desktop-host.ts'
import type { BotIdentityAccount } from './account-bot-identity.ts'
import { HostAuthorityError } from './types.ts'

export interface BotImportSourceGrantInput {
  readonly profileId: string
  readonly ownerId: string
  readonly scope: HostBotImportSourceScope
  readonly transfer: HostBotImportSourceRequest
  readonly signal: AbortSignal
}

export interface BotImportSourceGrantCheck {
  (input: BotImportSourceGrantInput): void | Promise<void>
}

interface TransferState {
  readonly profileId: string
  readonly ownerId: string
  readonly scope: HostBotImportSourceScope
  readonly operationId: string
  readonly eventDigest: string
  readonly eventCount: number
  readonly totalBytes: number
  nextOffset: number
}

/** One connection's volatile transfer map. It never grants access by itself. */
export class AccountBotImportSourceTransfers {
  private readonly active = new Map<string, TransferState>()
  private readonly busy = new Set<string>()
  private opening = 0

  constructor(
    private readonly host: Pick<DesktopHost, 'authorizeCollaborationRegistration' | 'authorizeAccountModelText'>,
    private readonly transfer: (profileId: string, request: HostBotImportSourceRequest,
      signal: AbortSignal) => Promise<HostBotImportSourceResult>,
    private readonly grant: BotImportSourceGrantCheck,
  ) {}

  clear(): void { this.active.clear(); this.busy.clear() }

  async run(account: BotIdentityAccount, scopeValue: HostBotImportSourceScope,
    requestValue: HostBotImportSourceRequest, signal: AbortSignal): Promise<HostBotImportSourceResult> {
    signal.throwIfAborted()
    const scope = parseHostBotImportSourceScope(scopeValue)
    const request = parseHostBotImportSourceRequest(requestValue)
    this.host.authorizeCollaborationRegistration(account)
    const profileId = this.host.authorizeAccountModelText(account)
    if (request.kind === 'open') {
      if (request.sourceDigest !== scope.source_digest || request.sessionId !== scope.session_id ||
          this.active.size + this.opening >= 2) throw new HostAuthorityError('unauthorized')
      this.opening++
    } else {
      const state = this.active.get(request.transferId)
      if (!state || state.profileId !== profileId || state.ownerId !== account.ownerId ||
          state.operationId !== request.operationId ||
          state.scope.source_digest !== scope.source_digest ||
          state.scope.session_id !== scope.session_id ||
          state.scope.target_device_id !== scope.target_device_id ||
          request.kind === 'next' && request.offset !== state.nextOffset ||
          this.busy.has(request.transferId)) throw new HostAuthorityError('unauthorized')
      this.busy.add(request.transferId)
    }
    try {
      await this.grant({ profileId, ownerId: account.ownerId, scope, transfer: request, signal })
      signal.throwIfAborted()
      const value = parseHostBotImportSourceResult(await this.transfer(profileId, request, signal), request)
      signal.throwIfAborted()
      this.host.authorizeCollaborationRegistration(account)
      if (this.host.authorizeAccountModelText(account) !== profileId) throw new HostAuthorityError('stale')
      await this.grant({ profileId, ownerId: account.ownerId, scope, transfer: request, signal })
      signal.throwIfAborted()
      if (request.kind === 'open') {
        if (!('transferId' in value) || 'offset' in value || value.sessionId !== scope.session_id ||
            this.active.has(value.transferId)) throw new HostAuthorityError('profile_mismatch')
        this.active.set(value.transferId, { profileId, ownerId: account.ownerId, scope,
          operationId: request.operationId, eventDigest: value.eventDigest,
          eventCount: value.eventCount, totalBytes: value.totalBytes, nextOffset: 0 })
      } else if (request.kind === 'next') {
        const state = this.active.get(request.transferId)
        if (!state || !('offset' in value) || value.sessionId !== scope.session_id ||
            value.eventDigest !== state.eventDigest || value.eventCount !== state.eventCount ||
            value.totalBytes !== state.totalBytes) throw new HostAuthorityError('profile_mismatch')
        if (value.nextOffset === null) this.active.delete(request.transferId)
        else state.nextOffset = value.nextOffset
      } else {
        if (!('closed' in value)) throw new HostAuthorityError('profile_mismatch')
        this.active.delete(request.transferId)
      }
      return value
    } finally {
      if (request.kind === 'open') this.opening--
      else this.busy.delete(request.transferId)
    }
  }
}
