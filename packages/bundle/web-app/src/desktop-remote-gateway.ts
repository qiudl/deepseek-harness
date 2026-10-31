/** Bind the authenticated Desktop private carrier to one Host-owned Peer. */
import type { InvokeRemoteRequest, TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'

type DesktopRequest = Omit<InvokeRemoteRequest, 'peer'>

/** Remote methods available to the Desktop carrier after its token is authenticated. */
export interface DesktopRemoteGateway {
  invoke(request: DesktopRequest): Promise<unknown>
  stream(request: DesktopRequest): Promise<AsyncIterable<unknown>>
  respondRemoteEvent: TypertGateway['respondRemoteEvent']
  readonly wireStream: {
    open(endpoint: string, payload: unknown, uplink: AsyncIterable<unknown>,
      peer: PeerScope | undefined, signal: AbortSignal): Promise<AsyncIterable<unknown>>
  }
}

/**
 * Bind every Gateway dispatch to the private carrier's owner Peer.
 * @param gateway - Host dispatcher.
 * @param peer - Peer owned by the carrier's Cordis scope.
 * @returns Desktop-only Gateway face.
 */
export function bindDesktopRemoteGateway(gateway: TypertGateway, peer: PeerScope): DesktopRemoteGateway {
  return {
    invoke: request => gateway.invoke({ ...request, peer }),
    stream: request => gateway.stream({ ...request, peer }),
    respondRemoteEvent: (result) =>{  gateway.respondRemoteEvent(result) },
    wireStream: { open: (endpoint, payload, uplink, _peer, signal) =>
      gateway.wireStream.open(endpoint, payload, uplink, peer, signal) },
  }
}
