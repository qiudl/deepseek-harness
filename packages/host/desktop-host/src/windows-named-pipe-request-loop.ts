import type { HostControlFrame } from '@deepseek-ai/dsh-host-control-protocol'
import { WindowsNamedPipeNativeError } from './windows-named-pipe-native.ts'

const ERROR_OPERATION_ABORTED = 995

/** Frame channel owned by one accepted and attested Windows pipe. */
export interface WindowsHostFrameDuplex {
  readFrame(): Promise<HostControlFrame | null>
  send(frame: HostControlFrame): Promise<void>
}

/** Shared-session bridge for the worker-local Windows request loop. */
export interface WindowsNamedPipeRequestLoopOptions {
  readonly channel: WindowsHostFrameDuplex
  readonly stopRequested: () => boolean
  readonly handleRequest: (request: HostControlFrame) => HostControlFrame | Promise<HostControlFrame>
}

/** Observable completion state used by Worker shutdown diagnostics. */
export interface WindowsNamedPipeRequestLoopResult {
  readonly requestsHandled: number
  readonly stopped: boolean
}

function correlatedResponse(response: HostControlFrame, request: HostControlFrame): boolean {
  return request.type === 'request'
    && (response.type === 'result' || response.type === 'error')
    && response.request_id === request.request_id
    && response.method === request.method
}

/**
 * Run strict sequential request/response framing for one Windows pipe connection.
 * The persistent stop flag is checked before every blocking read. A cancelled ReadFile
 * is clean only after that flag is visible; the same native error during normal service fails.
 * @param options - attested duplex, shared stop observation, and common Host session handler.
 * @returns clean EOF or requested-stop diagnostics after every completed response write.
 */
export async function runWindowsNamedPipeRequestLoop(
  options: WindowsNamedPipeRequestLoopOptions,
): Promise<WindowsNamedPipeRequestLoopResult> {
  let requestsHandled = 0
  for (;;) {
    if (options.stopRequested()) return { requestsHandled, stopped: true }
    let frame: HostControlFrame | null
    try { frame = await options.channel.readFrame() } catch (error) {
      if (options.stopRequested() && error instanceof WindowsNamedPipeNativeError
        && error.win32Code === ERROR_OPERATION_ABORTED) {
        return { requestsHandled, stopped: true }
      }
      throw error
    }
    if (frame === null) return { requestsHandled, stopped: options.stopRequested() }
    if (options.stopRequested()) return { requestsHandled, stopped: true }
    if (frame.type !== 'request') throw new Error('Windows Host expected a request frame')
    const response = await options.handleRequest(frame)
    if (!correlatedResponse(response, frame)) {
      throw new Error('Windows Host handler returned an uncorrelated response')
    }
    if (options.stopRequested()) return { requestsHandled, stopped: true }
    await options.channel.send(response)
    requestsHandled += 1
  }
}
