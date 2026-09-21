import type {
  HostAuthorizedParams,
  HostControlFrame,
  HostControlJti,
  HostInspectRequest,
  HostInspectResult,
} from '@deepseek-ai/dsh-host-control-protocol'
import { HostAuthorityError } from './types.ts'

interface HandshakeState {
  readonly clientInstanceId: HostAuthorizedParams['client_instance_id']
  readonly hostInstanceId: HostAuthorizedParams['host_instance_id']
  readonly processNonce: HostAuthorizedParams['process_nonce']
}

type HostControlRequest = Extract<HostControlFrame, { readonly type: 'request' }>
type HostAuthorizedRequest = Exclude<HostControlRequest, HostInspectRequest>

class HostControlResponseCorrelationError extends HostAuthorityError {
  constructor() { super('unavailable') }
}

/** Post-inspection expiry, process-generation, and single-use JTI authority. */
export class HostRequestAuthorizer {
  private readonly consumed = new Map<HostControlJti, number>()
  constructor(private readonly state: HandshakeState, private readonly now: () => number) {}

  /**
   * Consume one request authorization tuple exactly once.
   * @param params - process-bound request identity, expiry, and JTI.
   */
  authorize(params: HostAuthorizedParams): void {
    const current = this.now()
    for (const [jti, expiry] of this.consumed) if (expiry <= current) this.consumed.delete(jti)
    if (params.client_instance_id !== this.state.clientInstanceId || params.host_instance_id !== this.state.hostInstanceId
      || params.process_nonce !== this.state.processNonce) throw new HostAuthorityError('stale')
    if (params.issued_at >= params.expires_at || params.issued_at > current + 5_000 || params.issued_at < current - 30_000
      || params.expires_at <= current || params.expires_at - params.issued_at > 30_000) {
      throw new HostAuthorityError('stale')
    }
    if (this.consumed.has(params.jti)) throw new HostAuthorityError('replayed')
    this.consumed.set(params.jti, params.expires_at)
  }
}

/** Connection-owned context supplied to the shared Host request dispatcher. */
export interface HostControlServerSessionContext {
  readonly ownerId: string
  readonly signal: AbortSignal
}

/** Transport-independent dependencies for one authenticated Host control connection. */
export interface HostControlServerSessionOptions {
  readonly ownerId: string
  readonly now: () => number
  readonly signal?: AbortSignal
  readonly inspect: (request: HostInspectRequest) => HostInspectResult
  readonly dispatchAuthorized: (
    request: HostAuthorizedRequest,
    context: HostControlServerSessionContext,
    respond: (response: HostControlFrame) => void,
  ) => void | Promise<void>
  readonly errorResponse: (request: HostAuthorizedRequest, error: unknown) => HostControlFrame
  readonly revokeOwner: (ownerId: string) => void
}

function requestFrame(frame: HostControlFrame): HostControlRequest {
  if (frame.type !== 'request') throw new HostAuthorityError('unavailable')
  return frame
}

function correlated(response: HostControlFrame, request: HostControlRequest): boolean {
  return (response.type === 'result' || response.type === 'error')
    && response.request_id === request.request_id
    && response.method === request.method
}

/**
 * Own one post-peer-attestation Host control session shared by Unix and Windows carriers.
 * The first frame must inspect the Host, later frames require one-use authorization, and
 * connection abort revokes only this session's Host resources.
 */
export class HostControlServerSession {
  private readonly lifetime = new AbortController()
  private inspected = false
  private authorizer: HostRequestAuthorizer | undefined
  private closed = false
  private readonly abortFromTransport = (): void => { this.close() }

  constructor(private readonly options: HostControlServerSessionOptions) {
    if (options.signal?.aborted) this.close()
    else options.signal?.addEventListener('abort', this.abortFromTransport, { once: true })
  }

  /** Handle one sequential canonical control frame and return its correlated response. */
  async handleRequest(frame: HostControlFrame, signal?: AbortSignal): Promise<HostControlFrame> {
    if (this.closed || signal?.aborted) throw new HostAuthorityError('unavailable')
    const request = requestFrame(frame)
    const abort = (): void => { this.close() }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (!this.inspected) {
        if (request.method !== 'host.inspect') throw new HostAuthorityError('unavailable')
        const response = this.options.inspect(request)
        if (!correlated(response, request)) throw new HostAuthorityError('unavailable')
        this.authorizer = new HostRequestAuthorizer({
          clientInstanceId: request.params.client_instance_id,
          hostInstanceId: response.result.host_instance_id,
          processNonce: response.result.process_nonce,
        }, this.options.now)
        this.inspected = true
        return response
      }
      if (request.method === 'host.inspect' || !this.authorizer) throw new HostAuthorityError('unavailable')
      let response: HostControlFrame | undefined
      const respond = (candidate: HostControlFrame): void => {
        if (response !== undefined || !correlated(candidate, request)) throw new HostControlResponseCorrelationError()
        response = candidate
      }
      try {
        this.authorizer.authorize(request.params)
        await this.options.dispatchAuthorized(request, {
          ownerId: this.options.ownerId,
          signal: this.lifetime.signal,
        }, respond)
      } catch (error) {
        if (error instanceof HostControlResponseCorrelationError) throw error
        respond(this.options.errorResponse(request, error))
      }
      this.assertOpen()
      if (response === undefined) throw new HostAuthorityError('unavailable')
      return response
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  /** Abort owned work and revoke this connection exactly once. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.options.signal?.removeEventListener('abort', this.abortFromTransport)
    this.lifetime.abort()
    this.options.revokeOwner(this.options.ownerId)
  }

  private assertOpen(): void {
    if (this.closed) throw new HostAuthorityError('unavailable')
  }
}
