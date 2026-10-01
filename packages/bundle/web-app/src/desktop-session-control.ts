/** Profile-local control generations for Desktop and personal Web writers. */
import { randomUUID } from 'node:crypto'

const BROWSER_SESSION_WRITES = new Set(['session/create', 'session/selectModel', 'session/rename',
  'session/delete', 'session/fork', 'session/prompt', 'session/updateQueue', 'session/cancel'])
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u

/** Owner identity scoped to one Desktop Profile process. */
export interface DesktopSessionController {
  readonly kind: 'local' | 'remote'
  readonly id: string
}

/** Current owner and expiration returned by the Profile. */
export interface DesktopSessionClaim extends DesktopSessionController {
  readonly generation: string
  readonly epoch: number
  readonly expiresAt: number
}

/** Exact owner proof required by one write. */
export type DesktopSessionCredential = Pick<DesktopSessionClaim, 'kind' | 'id' | 'generation' | 'epoch'>

/** Control result without granting a claim on a read. */
export type DesktopSessionControlState =
  | { readonly outcome: 'uncontrolled'; readonly generation: string; readonly epoch: number }
  | { readonly outcome: 'controlled' | 'held_elsewhere' | 'epoch_stale'; readonly claim: DesktopSessionClaim }

/** Final, process-local authority for one Profile's Session writes. */
export class DesktopSessionControl {
  /** Random process generation that invalidates every claim on restart. */
  readonly generation = randomUUID()
  private readonly claims = new Map<string, DesktopSessionClaim>()
  private readonly activeWrites = new Map<string, number>()
  private readonly browser = { kind: 'local' as const, id: 'desktop-browser' }

  constructor(private readonly now: () => number = Date.now,
    private readonly ttlMs = 30_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 120_000) {
      throw new RangeError('desktop session control: invalid lease duration')
    }
  }

  /**
   * Describe one Session without granting control.
   * @param sessionId - selected Session.
   * @param caller - requesting owner.
   * @returns current control outcome.
   */
  status(sessionId: string, caller: DesktopSessionController): DesktopSessionControlState {
    this.validateSessionId(sessionId)
    const claim = this.claims.get(sessionId)
    if (!claim || (claim.expiresAt <= this.now() && (this.activeWrites.get(sessionId) ?? 0) === 0)) {
      return { outcome: 'uncontrolled', generation: this.generation, epoch: claim?.epoch ?? 0 }
    }
    return { outcome: this.sameOwner(claim, caller) ? 'controlled' : 'held_elsewhere', claim }
  }

  /**
   * Describe a Session from the authenticated Desktop browser's point of view.
   * @param sessionId - selected Session.
   * @returns local browser control state.
   */
  browserStatus(sessionId: string): DesktopSessionControlState {
    return this.status(sessionId, this.browser)
  }

  /**
   * Explicit, compare-and-swap takeover after the Desktop user confirms the observed owner.
   * @param sessionId - selected Session.
   * @param expectedEpoch - owner epoch seen before the confirmation.
   * @returns current control outcome.
   */
  takeoverBrowser(sessionId: string, expectedEpoch: number): DesktopSessionControlState {
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1) {
      throw new TypeError('desktop session control: invalid expected epoch')
    }
    return this.acquire(sessionId, this.browser, { takeover: true, expectedEpoch })
  }

  /**
   * Atomically acquire or explicitly take over one Session.
   * @param sessionId - selected Session.
   * @param caller - requesting owner.
   * @param input - takeover decision and observed epoch.
   * @returns current control outcome.
   */
  acquire(sessionId: string, caller: DesktopSessionController, input: {
    readonly takeover: boolean
    readonly expectedEpoch?: number
  }): DesktopSessionControlState {
    this.validateSessionId(sessionId)
    const previous = this.claims.get(sessionId)
    const now = this.now()
    const active = previous && (previous.expiresAt > now || (this.activeWrites.get(sessionId) ?? 0) > 0)
      ? previous : undefined
    if (active && this.sameOwner(active, caller)) {
      const claim = { ...active, expiresAt: now + this.ttlMs }
      this.claims.set(sessionId, claim)
      return { outcome: 'controlled', claim }
    }
    if (active) {
      if (!input.takeover) return { outcome: 'held_elsewhere', claim: active }
      if (input.expectedEpoch !== active.epoch) return { outcome: 'epoch_stale', claim: active }
      if ((this.activeWrites.get(sessionId) ?? 0) > 0) {
        return { outcome: 'held_elsewhere', claim: active }
      }
    }
    const claim: DesktopSessionClaim = { ...caller, generation: this.generation,
      epoch: (previous?.epoch ?? 0) + 1, expiresAt: now + this.ttlMs }
    this.claims.set(sessionId, claim)
    return { outcome: 'controlled', claim }
  }

  /**
   * Renew only the exact active generation, epoch, and owner.
   * @param sessionId - selected Session.
   * @param claim - Host-issued owner proof.
   * @returns current control outcome.
   */
  renew(sessionId: string, claim: DesktopSessionCredential): DesktopSessionControlState {
    const current = this.claims.get(sessionId)
    if (!current || !this.matches(current, claim) ||
      (current.expiresAt <= this.now() && (this.activeWrites.get(sessionId) ?? 0) === 0)) {
      return current ? { outcome: 'epoch_stale', claim: current } :
        { outcome: 'uncontrolled', generation: this.generation, epoch: 0 }
    }
    const renewed = { ...current, expiresAt: this.now() + this.ttlMs }
    this.claims.set(sessionId, renewed)
    return { outcome: 'controlled', claim: renewed }
  }

  /**
   * Release only the exact active generation, epoch, and owner.
   * @param sessionId - selected Session.
   * @param claim - Host-issued owner proof.
   * @returns true only when the active claim was released.
   */
  release(sessionId: string, claim: DesktopSessionCredential): boolean {
    const current = this.claims.get(sessionId)
    if (!current || !this.matches(current, claim) || current.expiresAt <= this.now() ||
      (this.activeWrites.get(sessionId) ?? 0) > 0) return false
    this.claims.set(sessionId, { ...current, expiresAt: this.now() })
    return true
  }

  /**
   * Reject a write unless its Host-issued claim still owns this Session.
   * @param sessionId - selected Session.
   * @param claim - Host-issued owner proof.
   */
  assertWrite(sessionId: string, claim: DesktopSessionCredential): void {
    const current = this.claims.get(sessionId)
    if (!current || !this.matches(current, claim) || current.expiresAt <= this.now()) {
      throw new Error('desktop session control: control lost')
    }
  }

  /**
   * Browser RPC operations that mutate an existing Session claim local control first.
   * @param endpoint - exact Session Remote method.
   * @param args - decoded wire arguments.
   * @returns disposer held through the invocation, or undefined for a read.
   */
  admitBrowserInvoke(endpoint: string, args: Readonly<Record<string, unknown>>): (() => void) | undefined {
    if (!BROWSER_SESSION_WRITES.has(endpoint)) return
    const request = args.request
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return
    const sessionId = Reflect.get(request, 'sessionId') as unknown
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return
    return this.admitBrowserWrite(sessionId)
  }

  /**
   * A browser approval result is also a Session write.
   * @param sessionId - event owner Session.
   * @returns disposer held through settlement.
   */
  admitBrowserWrite(sessionId: string): () => void {
    const state = this.acquire(sessionId, this.browser, { takeover: false })
    if (state.outcome !== 'controlled') {
      throw new Error('desktop session control: another client controls this Session')
    }
    return this.beginWrite(sessionId, state.claim)
  }

  /**
   * Hold the owner generation through an asynchronous write's settlement.
   * @param sessionId - selected Session.
   * @param claim - Host-issued owner proof.
   * @returns disposer that releases this write once.
   */
  beginWrite(sessionId: string, claim: DesktopSessionCredential): () => void {
    this.assertWrite(sessionId, claim)
    this.activeWrites.set(sessionId, (this.activeWrites.get(sessionId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.activeWrites.get(sessionId) ?? 1) - 1
      if (remaining === 0) this.activeWrites.delete(sessionId)
      else this.activeWrites.set(sessionId, remaining)
    }
  }

  private sameOwner(a: DesktopSessionController, b: DesktopSessionController): boolean {
    return a.kind === b.kind && a.id === b.id
  }

  private validateSessionId(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) throw new TypeError('desktop session control: invalid Session id')
  }

  private matches(a: DesktopSessionCredential, b: DesktopSessionCredential): boolean {
    return a.generation === b.generation && a.epoch === b.epoch && this.sameOwner(a, b)
  }
}
