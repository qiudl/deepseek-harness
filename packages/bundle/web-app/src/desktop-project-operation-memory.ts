/** Private authenticated operation-memory reader; its public service can only resolve live object tokens. */
import { randomUUID, verify, createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  HostProjectMemoryEnvironment,
  HostProjectMemoryDirective,
  HostProjectMemoryCommands,
} from '@deepseek-ai/dsh-host-control-protocol'
import {
  parseHostProjectMemoryRequest,
  encodeHostProjectMemoryDirective,
  hostProjectMemoryDirectiveDigest,
  parseHostProjectMemoryReadResult,
  parseHostProjectMemoryCheckpoint,
  parseHostTwinBindingInput,
  encodeHostTwinBindingDirective,
  hostTwinBindingOfferDigest,
} from '@deepseek-ai/dsh-host-control-protocol'
import type {
  ProjectOperationMemoryId as Id,
  ProjectOperationMemoryVersion as Version,
  ProjectOperationMemoryDigest as Digest,
  ProjectOperationMemorySequence as Sequence,
  ProjectOperationMemoryAuthorizationToken as Token,
  ProjectOperationMemoryAuthorizations as Reader,
  ProjectOperationMemoryAuthorization as View,
  ProjectOperationMemorySourceProducer as Producer,
  ProjectOperationMemoryScope as Scope,
  ProjectOperationMemoryActivationAnchor as Anchor,
  ProjectOperationMemoryCheckpoint as Checkpoint,
  ProjectOperationMemoryReadCommands as Commands,
  ProjectOperationMemoryConfirmation as Confirmation,
  ProjectOperationMemoryLocalIdentity as Local,
} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'

const unavailable = (): never => {
  throw Object.assign(Error('project_operation_memory_unavailable'), { code: 'capability_unavailable' })
}
const id = (v: string): Id => v as Id
const version = (v: string): Version => v as Version
const digest = (v: string): Digest => v as Digest
const sequence = (v: string): Sequence => v as Sequence
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return unavailable()
  return Object.fromEntries(
    keys.map((k) => {
      const d = Object.getOwnPropertyDescriptor(value, k)
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) return unavailable()
      const v: unknown = d.value
      return [k, v]
    }),
  )
}
function text(v: unknown, pattern: RegExp): string {
  if (typeof v !== 'string' || !pattern.test(v)) return unavailable()
  return v
}
const ascii = (v: unknown): string => {
  const s = text(v, /^[!-~]{1,256}$/u)
  if (/[/\\]/u.test(s) || s === '.' || s === '..') return unavailable()
  return s
}
const uuid = (v: unknown): string =>
  text(v, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
const sha = (v: unknown): string => text(v, /^[a-f0-9]{64}$/u)
function decimal(v: unknown, positive: boolean): string {
  const s = text(v, /^(0|[1-9][0-9]{0,18})$/u)
  if (BigInt(s) > 9223372036854775807n || (positive && s === '0')) return unavailable()
  return s
}
function ownership(value: unknown): Anchor['ownership'] {
  const x = row(value, ['hostProfileId', 'botId', 'actorRef', 'sessionIds'])
  if (!Array.isArray(x.sessionIds) || x.sessionIds.length > 10000) return unavailable()
  const sessions = x.sessionIds.map(s => ascii(s) as SessionId)
  if (sessions.some((s, i) => i > 0 && s <= (sessions[i - 1] as string))) return unavailable()
  return {
    hostProfileId: id(uuid(x.hostProfileId)),
    botId: id(ascii(x.botId)),
    actorRef: id(ascii(x.actorRef)),
    sessionIds: sessions,
  }
}
function anchor(value: unknown): Anchor {
  const x = row(value, [
    'anchorId',
    'confirmationDigest',
    'journalEpoch',
    'activationSequence',
    'syncStartSequence',
    'sourceAuthorityVersion',
    'ownership',
  ])
  return {
    anchorId: id(uuid(x.anchorId)),
    confirmationDigest: digest(sha(x.confirmationDigest)),
    journalEpoch: id(ascii(x.journalEpoch)),
    activationSequence: sequence(decimal(x.activationSequence, false)),
    syncStartSequence: sequence(decimal(x.syncStartSequence, false)),
    sourceAuthorityVersion: version(decimal(x.sourceAuthorityVersion, true)),
    ownership: ownership(x.ownership),
  }
}
function confirmation(value: unknown, acknowledged: boolean): Confirmation & { ackDigest?: Digest } {
  const keys = ['requestId', 'offerDigest', 'payloadDigest', 'anchorId', 'confirmationDigest']
  const x = row(value, acknowledged ? [...keys, 'ackDigest'] : keys)
  return {
    requestId: id(uuid(x.requestId)),
    offerDigest: digest(sha(x.offerDigest)),
    payloadDigest: digest(sha(x.payloadDigest)),
    anchorId: id(uuid(x.anchorId)),
    confirmationDigest: digest(sha(x.confirmationDigest)),
    ...(acknowledged ? { ackDigest: digest(sha(x.ackDigest)) } : {}),
  }
}
function scope(s: HostProjectMemoryDirective['scope']): Scope {
  const r = s.sourceRef,
    p = s.recipientRef,
    c = s.retentionConsentRef
  return {
    bindingId: id(s.bindingId),
    bindingGeneration: version(s.bindingGeneration),
    scopeVersion: version(s.scopeVersion),
    projectId: id(s.projectId),
    twinAgentId: id(s.twinAgentId),
    twinAuthorityDigest: digest(s.twinAuthorityDigest),
    sourceRef: {
      side: r.side,
      actorRef: id(r.actorRef),
      // Both source-only callers reject null/current-Profile mismatches before mapping the scope.
      hostProfileId: id(r.hostProfileId as string),
      botRootId: id(r.botRootId as string),
      providerId: id(r.providerId),
      providerVersion: id(r.providerVersion),
    },
    recipientRef: {
      side: p.side,
      botRef: id(p.botRef),
      audienceKind: p.audienceKind,
      audienceRef: id(p.audienceRef),
      audienceVersion: p.audienceVersion,
      audienceDigest: digest(p.audienceDigest),
    },
    deviceGrantRefs: s.deviceGrantRefs.map(v => ({
      grantId: id(v.grantId),
      expectedEpoch: version(v.expectedEpoch),
    })),
    workspaceRefs: s.workspaceRefs.map(v => ({
      workspaceId: id(v.workspaceId),
      grantId: id(v.grantId),
      expectedEpoch: version(v.expectedEpoch),
    })),
    historyFrom: s.historyFrom,
    historyTo: s.historyTo,
    timeZone: s.timeZone,
    materialKinds: s.materialKinds as Scope['materialKinds'],
    retentionConsentRef: {
      id: id(c.id),
      generation: version(c.generation),
      consentDigest: digest(c.consentDigest),
      presentationVersion: c.presentationVersion,
    },
    scopeDigest: digest(s.scopeDigest),
  }
}
function checkpoint(c: import('@deepseek-ai/dsh-host-control-protocol').HostProjectMemoryCheckpoint): Checkpoint {
  return {
    journalEpoch: id(c.journalEpoch),
    sequence: sequence(c.sequence),
    scopeDigest: digest(c.scopeDigest),
    recipientDigest: digest(c.recipientDigest),
  }
}
function command<O extends keyof Commands>(operation: O, value: HostProjectMemoryCommands[O]): Commands[O] {
  const c = value
  if (operation === 'prepare_snapshot') {
    const p = c as HostProjectMemoryCommands['prepare_snapshot']
    return (
      p.mode === 'resume'
        ? {
          requestId: id(p.requestId),
          expectedScopeVersion: version(p.expectedScopeVersion),
          mode: p.mode,
          resumeOperation: p.resumeOperation,
          journalEpoch: id(p.journalEpoch),
          snapshotId: p.snapshotId === null ? null : id(p.snapshotId),
          throughSequence: sequence(p.throughSequence),
          checkpoint: checkpoint(p.checkpoint),
          queryDigest: p.queryDigest === null ? null : digest(p.queryDigest),
        }
        : { requestId: id(p.requestId), expectedScopeVersion: version(p.expectedScopeVersion), mode: p.mode }
    ) as Commands[O]
  }
  if (operation === 'history_page' || operation === 'delta_page') {
    const p = c as HostProjectMemoryCommands['history_page']
    return {
      ...(operation === 'history_page' ? { snapshotId: id(p.snapshotId) } : {}),
      journalEpoch: id(p.journalEpoch),
      afterCursor: p.afterCursor === null ? null : id(p.afterCursor),
      throughSequence: sequence(p.throughSequence),
      pageSize: p.pageSize,
      maxBytes: p.maxBytes,
    } as Commands[O]
  }
  if (operation === 'search') {
    const p = c as HostProjectMemoryCommands['search']
    return {
      query: p.query,
      queryDigest: digest(p.queryDigest),
      limit: p.limit,
      maxBytes: p.maxBytes,
      cursor: p.cursor === null ? null : id(p.cursor),
    } as Commands[O]
  }
  const p = c as HostProjectMemoryCommands['evidence']
  return {
    sourceEventId: id(p.sourceEventId),
    sourceRevision: version(p.sourceRevision),
    rightId: p.rightId === null ? null : id(p.rightId),
    rightGeneration: p.rightGeneration === null ? null : version(p.rightGeneration),
    offset: p.offset,
    maxBytes: p.maxBytes,
  } as Commands[O]
}
function freeze<T>(value: T, signal: AbortSignal): T {
  if (value && typeof value === 'object' && !Object.is(value, signal)) {
    for (const child of Object.values(value)) freeze(child, signal)
    Object.freeze(value)
  }
  return value
}
function producer(value: unknown): Producer {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof Reflect.get(value, 'execute') !== 'function' ||
    typeof Reflect.get(value, 'captureAnchor') !== 'function'
  )
    return unavailable()
  return value as Producer
}
const codes = new Set([
  'unauthorized',
  'binding_inactive',
  'scope_changed',
  'source_changed',
  'material_revoked',
  'journal_epoch_changed',
  'cursor_invalid',
  'cursor_expired',
  'capability_unavailable',
  'payload_too_large',
  'conflict',
  'timeout',
])
/** One Profile worker owns the request registry and its read-only SDK provider. */
export class DesktopProjectOperationMemory {
  private readonly workerId = id(randomUUID())
  private readonly tokens = new WeakMap<Token, { view: View; owner: Producer }>()
  /** Synchronous stable-view reader; no caller can mint, queue, extend or transfer a token. */
  readonly reader: Reader = Object.freeze({ read: (token: Token) => this.read(token) })
  constructor(
    private readonly ctx: Context,
    private readonly environments: readonly HostProjectMemoryEnvironment[],
    private readonly profileId: string,
    private readonly lifetime: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {}
  private localAccount(
    d: Readonly<{
      authorityEnvironmentId: string
      accountIssuer: string
      accountSubject: string
      accountBindingId: string
      accountBindingVersion: number
    }>,
    botId: string,
  ): Omit<Local, 'peer'> {
    return {
      authorityEnvironmentId: id(d.authorityEnvironmentId),
      accountIssuer: d.accountIssuer,
      accountSubject: id(d.accountSubject),
      accountBindingId: id(d.accountBindingId),
      accountBindingVersion: d.accountBindingVersion,
      hostProfileId: id(this.profileId),
      botId: id(botId),
      workerId: this.workerId,
    }
  }
  private read(token: Token): View | null {
    const entry = this.tokens.get(token)
    if (!entry) return null
    if (
      entry.view.signal.aborted ||
      this.now() >= entry.view.deadline ||
      this.ctx.get('projectOperationMemoryAuthorizations') !== this.reader ||
      this.ctx.get('dsBotProjectOperationMemory') !== entry.owner
    ) {
      this.tokens.delete(token)
      return null
    }
    return entry.view
  }

  private signed(
    d: {
      authorityEnvironmentId: string
      issuer: string
      keyId: string
      issuedAt: number
      expiresAt: number
      signature: string
    },
    payload: string,
  ): void {
    const policy = this.environments.find(
      e => e.keyring.environmentId === d.authorityEnvironmentId && e.keyring.issuer === d.issuer,
    )
    const key = policy?.keyring.keys.find(k => k.kid === d.keyId)
    const now = this.now()
    if (
      'audience' in d &&
      (d.issuedAt > now ||
        !policy ||
        d.audience !== policy.audience ||
        !('environmentKey' in d) ||
        d.environmentKey !== policy.environmentKey)
    )
      return unavailable()
    if (
      !key ||
      !Number.isSafeInteger(now) ||
      now < 0 ||
      d.issuedAt > now + 5000 ||
      d.expiresAt <= now ||
      key.validFrom > d.issuedAt ||
      key.validUntil < d.expiresAt ||
      !verify(null, Buffer.from(payload), key.publicKeyPem, Buffer.from(d.signature, 'base64url'))
    )
      throw Object.assign(Error('project_operation_memory_unauthorized'), { code: 'unauthorized' })
  }
  private identity(
    raw: Record<string, unknown>,
    d: {
      authorityEnvironmentId: string
      accountIssuer: string
      accountSubject: string
      accountBindingId: string
      accountBindingVersion: number
    },
    peer: { installationId: string; publicKey: string; hostInstanceId: string; processNonce: string },
  ) {
    const a = row(raw.actualAccount, [
      'authorityEnvironmentId',
      'accountIssuer',
      'accountSubject',
      'accountBindingId',
      'accountBindingVersion',
      'hostProfileId',
    ])
    const p = row(raw.actualPeer, ['installationId', 'publicKey', 'hostInstanceId', 'processNonce'])
    if (
      a.hostProfileId !== this.profileId ||
      ['authorityEnvironmentId', 'accountIssuer', 'accountSubject', 'accountBindingId', 'accountBindingVersion'].some(
        k => a[k] !== Reflect.get(d, k),
      ) ||
      ['installationId', 'publicKey', 'hostInstanceId', 'processNonce'].some(k => p[k] !== Reflect.get(peer, k))
    )
      throw Object.assign(Error('project_operation_memory_unauthorized'), { code: 'unauthorized' })
    return a
  }
  /** Capture metadata only under the exact original verified confirmation; no source read or export is admitted.
   * @param value - Private parent input, actual Account/peer and durable original intent identity.
   * @param signal - Original confirmation request cancellation.
   * @returns The actual persist-once source anchor, or null when the producer is absent before admission.
   */
  async captureAnchor(value: unknown, signal: AbortSignal): Promise<unknown> {
    const raw = row(value, ['action', 'input', 'binding_key', 'actualAccount', 'actualPeer', 'confirmation'])
    const input = parseHostTwinBindingInput(raw.input),
      d = input.directive
    if (
      raw.action !== 'project_operation_memory_anchor' ||
      input.command.operation !== 'confirm' ||
      d.purpose !== 'twin_binding_confirm'
    )
      return unavailable()
    this.signed(d, encodeHostTwinBindingDirective(d))
    this.identity(raw, d, d.peer)
    const s = input.command.offer.directions[0].scope,
      source = s.sourceRef
    if (
      source.side !== 'dsh' ||
      source.hostProfileId !== this.profileId ||
      !source.botRootId ||
      source.actorRef !== 'deepseek-bot:' + source.botRootId ||
      source.providerId !== 'dsh-project-operation-v1' ||
      source.providerVersion !== '1'
    )
      return unavailable()
    const current: unknown = this.ctx.get('dsBotProjectOperationMemory')
    if (current === undefined || current === null) return null
    const owner = producer(current),
      c = confirmation(raw.confirmation, false),
      semanticScope = scope(s)
    const recipientDigest = createRecipientDigest(semanticScope.recipientRef)
    const expected = createHash('sha256')
      .update(
        'dsh.project-operation-memory-confirmation/v1\0' +
          JSON.stringify([
            d.authorityEnvironmentId,
            d.ownerUserId,
            source.hostProfileId,
            source.botRootId,
            d.requestId,
            d.bindingId,
            d.bindingGeneration,
            d.scopeVersion,
            d.scopeDigest,
            d.payloadDigest,
            s.scopeDigest,
            recipientDigest,
          ]),
      )
      .digest('hex')
    if (
      c.requestId !== d.requestId ||
      c.offerDigest !== hostTwinBindingOfferDigest(input.command.offer) ||
      c.payloadDigest !== d.payloadDigest ||
      c.confirmationDigest !== expected
    )
      return unavailable()
    const active = AbortSignal.any([signal, this.lifetime, AbortSignal.timeout(Math.max(1, d.expiresAt - this.now()))])
    const view = freeze(
      {
        purpose: 'binding_activation_anchor' as const,
        mode: 'source_export' as const,
        operation: null,
        command: null,
        readDirectiveDigest: null,
        requestId: id(d.requestId),
        ownerUserId: id(d.ownerUserId),
        authorityEnvironmentId: id(d.authorityEnvironmentId),
        projectId: id(s.projectId),
        scope: semanticScope,
        scopeDigest: digest(s.scopeDigest),
        recipientDigest,
        confirmation: c,
        deadline: d.expiresAt,
        signal: active,
        local: {
          ...this.localAccount(d, source.botRootId),
          peer: {
            computerId: id(d.computerId),
            installationId: id(d.peer.installationId),
            hostRegistryId: null,
            hostEpoch: null,
            publicKey: d.peer.publicKey,
            hostInstanceId: id(d.peer.hostInstanceId),
            processNonce: d.peer.processNonce,
          },
        },
      },
      active,
    )
    const token = Object.freeze({}) as Token
    this.tokens.set(token, { view, owner })
    try {
      if (this.read(token) !== view) return unavailable()
      const captured = anchor(await awaitProducer(owner.captureAnchor(token), active))
      if (
        this.read(token) !== view ||
        captured.anchorId !== c.anchorId ||
        captured.confirmationDigest !== c.confirmationDigest ||
        captured.ownership.hostProfileId !== this.profileId ||
        captured.ownership.botId !== source.botRootId ||
        captured.ownership.actorRef !== source.actorRef
      )
        return unavailable()
      return captured
    } finally {
      this.tokens.delete(token)
    }
  }
  /** Execute only a private source read; delivery operations and retained reads never reach DSP.
   * @param value - Exact parent-authenticated request plus original durable confirmation/anchor/plan metadata.
   * @param signal - Original authenticated Main request cancellation.
   * @returns Actual bounded result metadata for the Host signer, or a closed read error.
   */
  async execute(value: unknown, signal: AbortSignal): Promise<unknown> {
    const raw = row(value, [
      'action',
      'request',
      'binding_key',
      'actualAccount',
      'actualPeer',
      'confirmation',
      'anchor',
      'plan',
      'currentCommittedCheckpoint',
    ])
    const req = parseHostProjectMemoryRequest(raw.request),
      d = req.directive
    try {
      if (d.operation === 'apply' || d.operation === 'receipt')
        return { status: 'error', code: 'capability_unavailable', requestId: d.requestId, retryable: false }
      if (
        raw.action !== 'project_operation_memory' ||
        !d.peer ||
        d.direction !== 'dsh_to_slark' ||
        d.scope.sourceRef.hostProfileId !== this.profileId ||
        !d.scope.sourceRef.botRootId ||
        d.scope.sourceRef.providerId !== 'dsh-project-operation-v1' ||
        d.scope.sourceRef.providerVersion !== '1'
      )
        return unavailable()
      this.signed(d, encodeHostProjectMemoryDirective(d))
      this.identity(raw, d, d.peer)
      const active = AbortSignal.any([
        signal,
        this.lifetime,
        AbortSignal.timeout(Math.max(1, d.expiresAt - this.now())),
      ])
      active.throwIfAborted()
      const owner = producer(this.ctx.get('dsBotProjectOperationMemory')),
        c = confirmation(raw.confirmation, true),
        a = anchor(raw.anchor)
      if (
        !c.ackDigest ||
        c.anchorId !== a.anchorId ||
        c.confirmationDigest !== a.confirmationDigest ||
        a.ownership.hostProfileId !== this.profileId ||
        a.ownership.botId !== d.scope.sourceRef.botRootId ||
        a.ownership.actorRef !== d.scope.sourceRef.actorRef
      )
        return unavailable()
      const p =
        raw.plan === null
          ? null
          : row(raw.plan, ['requestId', 'contextDigest', 'sourceAuthorityVersion', 'journalEpoch', 'syncStartSequence'])
      if (p && p.requestId !== d.requestId) return unavailable()
      const v = scope(d.scope),
        r = v.recipientRef
      const recipientDigest = createRecipientDigest(r)
      const common = {
        requestId: id(d.requestId),
        ownerUserId: id(d.ownerUserId),
        authorityEnvironmentId: id(d.authorityEnvironmentId),
        projectId: id(d.scope.projectId),
        scope: v,
        scopeDigest: digest(d.scope.scopeDigest),
        recipientDigest,
        deadline: d.expiresAt,
        signal: active,
        local: {
          ...this.localAccount(d, d.scope.sourceRef.botRootId),
          peer: {
            computerId: id(d.peer.computerId),
            installationId: id(d.peer.installationId),
            hostRegistryId: id(d.peer.hostRegistryId),
            hostEpoch: version(d.peer.hostEpoch),
            publicKey: d.peer.publicKey,
            hostInstanceId: id(d.peer.hostInstanceId),
            processNonce: d.peer.processNonce,
          },
        },
      }
      const committed =
        raw.currentCommittedCheckpoint === null
          ? null
          : parseHostProjectMemoryCheckpoint(raw.currentCommittedCheckpoint)
      if (
        committed &&
        (committed.journalEpoch !== (a.journalEpoch as string) ||
          committed.scopeDigest !== d.scope.scopeDigest ||
          committed.recipientDigest !== (recipientDigest as string) ||
          BigInt(committed.sequence) < BigInt(a.syncStartSequence))
      )
        return unavailable()
      const view = freeze(
        {
          ...common,
          purpose: 'source_read' as const,
          mode: 'source_export' as const,
          operation: d.operation,
          command: command(d.operation, req.commandBody as HostProjectMemoryCommands[typeof d.operation]),
          readDirectiveDigest: digest(hostProjectMemoryDirectiveDigest(d)),
          authorityDigest: digest(d.authorityDigest),
          confirmation: { ...c, ackDigest: c.ackDigest },
          anchor: a,
          ...(committed === null ? {} : { currentCommittedCheckpoint: checkpoint(committed) }),
          expectedSourceAuthorityVersion: p === null ? null : version(decimal(p.sourceAuthorityVersion, true)),
          expectedJournalEpoch: p === null ? null : id(ascii(p.journalEpoch)),
        },
        active,
      ) as View
      const token = Object.freeze({}) as Token
      this.tokens.set(token, { view, owner })
      try {
        if (this.read(token) !== view) return unavailable()
        const reply = await awaitProducer(owner.execute(token), active)
        if (this.read(token) !== view) return unavailable()
        const out = row(reply, [
          'sourceAuthorityVersion',
          'journalEpoch',
          'snapshotId',
          'previousCheckpoint',
          'ownership',
          'operation',
          'result',
        ])
        const owned = ownership(out.ownership)
        if (
          out.operation !== d.operation ||
          owned.hostProfileId !== this.profileId ||
          owned.botId !== d.scope.sourceRef.botRootId ||
          owned.actorRef !== d.scope.sourceRef.actorRef
        )
          return unavailable()
        const result = parseHostProjectMemoryReadResult(d.operation, out.result)
        if (
          ('events' in result &&
            result.events.some(e => e.sourcePolicy !== 'live_reference_v1' || e.materialDependencies.length !== 0)) ||
          ('items' in result &&
            result.items.some(i => i.snippet !== '' || i.rightId !== null || i.rightGeneration !== null)) ||
          (d.operation === 'evidence' && (!('status' in result) || result.status !== 'missing'))
        )
          return unavailable()
        const sourceAuthorityVersion = decimal(out.sourceAuthorityVersion, true),
          journalEpoch = ascii(out.journalEpoch)
        if (
          (p && (p.sourceAuthorityVersion !== sourceAuthorityVersion || p.journalEpoch !== journalEpoch)) ||
          a.journalEpoch !== journalEpoch
        )
          throw Object.assign(Error('project_operation_memory_source_changed'), { code: 'source_changed' })
        const snapshotId = out.snapshotId === null ? null : ascii(out.snapshotId)
        const previousCheckpoint =
          out.previousCheckpoint === null ? null : parseHostProjectMemoryCheckpoint(out.previousCheckpoint)
        if ((d.operation === 'history_page' || d.operation === 'delta_page') !== (previousCheckpoint !== null))
          return unavailable()
        if (
          previousCheckpoint &&
          (previousCheckpoint.journalEpoch !== journalEpoch ||
            previousCheckpoint.scopeDigest !== d.scope.scopeDigest ||
            previousCheckpoint.recipientDigest !== (recipientDigest as string))
        )
          return unavailable()
        if (this.read(token) !== view) return unavailable()
        return {
          operation: d.operation,
          sourceAuthorityVersion,
          journalEpoch,
          snapshotId,
          previousCheckpoint,
          ownership: owned,
          result,
        }
      } finally {
        this.tokens.delete(token)
      }
    } catch (error) {
      const code: unknown =
        error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      return {
        status: 'error',
        code:
          typeof code === 'string' && codes.has(code)
            ? code
            : signal.aborted || this.lifetime.aborted || this.now() >= d.expiresAt
              ? 'timeout'
              : 'capability_unavailable',
        requestId: d.requestId,
        retryable: false,
      }
    }
  }
}
function createRecipientDigest(r: Scope['recipientRef']): Digest {
  return createHash('sha256')
    .update(
      'slark.project-operation-memory.recipient/v1\0' +
        JSON.stringify([r.side, r.botRef, r.audienceKind, r.audienceRef, r.audienceVersion, r.audienceDigest]),
    )
    .digest('hex') as Digest
}

function awaitProducer<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new DOMException('Memory request cancelled', 'AbortError'))
    }
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error instanceof Error ? error : Error('project_operation_memory_unavailable'))
      },
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
