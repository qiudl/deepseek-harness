import type { HostControlFrame, HostInspectRequest, HostInspectResult } from './types.ts';
/** Maximum UTF-8 bytes in one JSON object, excluding its terminating LF. */
export declare const HOST_CONTROL_MAX_FRAME_BYTES: number;
/** Machine-readable reasons a local frame cannot be accepted. */
export type HostControlProtocolFailure = 'invalid_frame' | 'frame_too_large' | 'unsupported_protocol' | 'unknown_method';
/** A safe local decoder failure; it never embeds untrusted frame contents. */
export declare class HostControlProtocolError extends Error {
    /** Stable failure category for broker/Host handling and metrics. */
    readonly code: HostControlProtocolFailure;
    constructor(code: HostControlProtocolFailure);
}
/**
 * Encode one canonical JSON-Lines frame. Key order, LF termination, finite
 * numbers, and frame size are part of the wire contract.
 * @param frame - typed Host control frame to validate at runtime.
 * @returns canonical LF-terminated JSON frame.
 */
export declare function encodeHostControlFrame(frame: HostControlFrame): string;
/**
 * Decode exactly one canonical, LF-terminated frame. Malformed input is never
 * skipped: callers must close the connection after any thrown error.
 * @param source - one complete LF-terminated frame.
 * @returns validated Host control frame.
 */
export declare function decodeHostControlFrame(source: string): HostControlFrame;
/**
 * Build the exact UTF-8 signing statement for a `host.inspect` response. It
 * binds both sides' nonces and identities plus every negotiated Host fact; the
 * signature field itself is deliberately excluded.
 * @param request - fresh Desktop inspection challenge.
 * @param response - Host inspection result whose signature field is excluded.
 * @returns domain-separated UTF-8 signing bytes.
 */
export declare function encodeHostInspectSignaturePayload(request: HostInspectRequest, response: HostInspectResult): Uint8Array;
//# sourceMappingURL=codec.d.ts.map