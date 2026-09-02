# Agent Note: Single-Host local control protocol

Status: implemented

English | [中文](2026-09-02-single-host-control-protocol.zh.md)

## Problem

REQ-20260901-0020 makes one machine-wide DSH Host serve Desktop clients from Slark staging and production. The repository's SDK JSON-RPC protocol is the wrong boundary: it is an agent-runtime stdio carrier, ignores malformed lines, and does not own installation identity. Reusing it would let a security-sensitive local supervisor continue after ambiguous input and would couple Desktop lifecycle control to the public SDK surface.

The Host and broker need an independent first message before any profile, environment, session, migration, or upgrade command can be trusted. That first message must negotiate a protocol version, prove liveness against a fresh challenge, identify the installation and current process, and describe exactly which later operations exist.

## Decision

`@deepseek-ai/dsh-host-control-protocol` is a zero-I/O Host-group library. It owns a canonical JSON-Lines envelope, a 64 KiB object cap, branded cross-boundary identities, a bounded error vocabulary, and the version-1 `host.inspect` exchange. Malformed input is connection-fatal. The decoder requires exact key order and shape, then re-encodes the normalized value and compares bytes, rejecting duplicate keys, alternate number spellings, whitespace variants, CRLF, extra lines, and unknown fields. The encoder runs the same runtime validation instead of trusting erased TypeScript types.

The request carries a fresh 32-byte challenge, an ephemeral Desktop client id, and a descending unique version list that includes version 1. The response selects version 1 and carries distinct Host-process and persistent-installation ids, the installation Ed25519 public key, positive runtime/schema generations, a process nonce, sorted unique capabilities including `host.inspect`, and an independently comparable executable-signature digest.

The challenge signature is not defined as “sign the response JSON.” `encodeHostInspectSignaturePayload` constructs a domain-separated statement that binds every request and response fact except the signature itself. A golden vector fixes the exact UTF-8 bytes for non-TypeScript implementations. The returned public key is identification, not self-authentication: the broker must compare it to a trusted installation record and independently inspect the peer executable before signature acceptance.

Later operation tasks extend the decoded payload union. They do not weaken the frame boundary or put transport, authorization, migration, or Host process state into this package.

## Defect-analysis iterations

Round 1 found four defects: outbound values were not runtime-validated, base64url trailing bits were not canonicalized, the Desktop client id reused the Host identity brand, and version negotiation accepted only `[1]`. All four are covered by focused tests.

Round 2 found three protocol gaps: the signed preimage was undefined, a capability response could omit the baseline method, and Host process/installation identities could collapse to the same value. The domain-separated signing vector, required baseline capability, installation public key, positive generations, and distinct-id check close them.

Round 3 found no new package-owned defect. Transport buffering, peer credential checks, cryptographic verification, replay state, and operation payloads remain explicit consumer responsibilities and are named in the package limitations rather than partially implemented here.

## Alternatives considered

**Reuse the SDK JSON-RPC carrier.** It is an agent-runtime stdio protocol that skips malformed lines and does not own installation identity, so it cannot enforce connection-fatal local supervisor authentication.

**Trust the socket path or the returned public key.** Either can be substituted by an untrusted local process. The broker instead requires registry-owned installation trust plus native evidence for the connected executable.

## Consequences

The protocol deliberately rejects semantically equivalent JSON. This reduces parser differential and cross-language ambiguity, but every implementation must follow the committed golden vectors. A peer advertising a future version can still negotiate down by sending (for example) `[2,1]`; version-1 framing remains the compatibility bootstrap.

A decoder receives a complete string, so it can reject an oversized frame but cannot prevent the transport from first buffering it. The Unix-domain-socket carrier must enforce the byte cap incrementally and close on the first error. Invalid input without a trustworthy request id receives no error frame; the connection closes.

## Testing

The focused suite starts from committed request, result, error, and signing-payload vectors and round-trips them byte-for-byte. Negative coverage pins extra and missing fields, whitespace, multiple frames, size overflow, forged outbound data, non-canonical base64url, missing baseline capability, reused identities, and future-client downgrade negotiation.
