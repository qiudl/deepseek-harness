# Agent Note: Single-Host local control protocol

Status: implemented

English | [中文](2026-09-02-single-host-control-protocol.zh.md)

## Problem

REQ-20260901-0020 makes one machine-wide DSH Host serve Desktop clients from Slark staging and production. The repository's SDK JSON-RPC protocol is the wrong boundary: it is an agent-runtime stdio carrier, ignores malformed lines, and does not own installation identity. Reusing it would let a security-sensitive local supervisor continue after ambiguous input and would couple Desktop lifecycle control to the public SDK surface.

The Host and broker need an independent first message before any profile, environment, session, migration, or upgrade command can be trusted. That first message must negotiate a protocol version, prove liveness against a fresh challenge, identify the installation and current process, and describe exactly which later operations exist.

## Decision

`@deepseek-ai/dsh-host-control-protocol` is a zero-I/O Host-group library. It owns a canonical JSON-Lines envelope, a 64 KiB object cap, branded cross-boundary identities, a bounded error vocabulary, and the version-1 `host.inspect` exchange. Malformed input is connection-fatal. The decoder requires exact key order and shape, then re-encodes the normalized value and compares bytes, rejecting duplicate keys, alternate number spellings, whitespace variants, CRLF, extra lines, and unknown fields. The encoder runs the same runtime validation instead of trusting erased TypeScript types.

The request carries a fresh 32-byte challenge, an ephemeral Desktop client id, and a descending unique version list that includes version 1. The response selects version 1 and carries distinct Host-process and persistent-installation ids, the installation Ed25519 public key, positive runtime/schema generations, a durable positive Host generation, a process nonce, sorted unique capabilities including `host.inspect`, and an independently comparable executable-signature digest. The single-instance owner atomically increments an owner-private generation file before publishing each Host process. Every later authorized frame repeats that generation, so authentication against an earlier process cannot authorize work after a restart.

The challenge signature is not defined as “sign the response JSON.” `encodeHostInspectSignaturePayload` constructs a domain-separated statement that binds every request and response fact except the signature itself. A golden vector fixes the exact UTF-8 bytes for non-TypeScript implementations. The returned public key is identification, not self-authentication: the broker must compare it to a trusted installation record and independently inspect the peer executable before signature acceptance.

Later operation tasks extend the decoded payload union. They do not weaken the frame boundary or put transport, authorization, migration, or Host process state into this package.

Every broker connection attaches one authority-environment Session before any non-Session operation. The Host accepts exact attach retries, rejects a different environment on the same connection, requires monotonically increasing Session generation and permission epoch, and requires protocol version 1 plus the exact Profile format generation. Advancing an environment's permission epoch fences its older connected Sessions before their next operation. Detach requires the current generation; its exact retry returns the original active count, while that generation cannot attach again. Connection closure removes the Session and releases its Profile references. Environment-bearing Profile operations must match the attached environment.

Desktop windows own Sessions, not Host lifetime. Environment switching and application exit detach the current Session and relinquish the child-process handle without signaling the installation-wide Host. Update, removal, migration rollback, or a dedicated installation lifecycle may stop it. This separation avoids both cross-environment process churn and the detach-count-to-SIGTERM race in which another environment attaches after an observed zero count.

`profile.ensure` carries a short-lived ES256 access token issued by the canonical DSH Account authority for the `dsh-host` audience. The `profile.ensure_account_token` capability marks this payload revision. A new client refuses to send the revised payload to a Host without the capability, while a new Host still decodes the legacy payload and returns `upgrade_required` before registry access. The Host verifies the exact JWT shape and signature against an owner-private public keyring whose SHA-256 digest is pinned by the embedding release, then requires the verified issuer and subject to equal the Desktop-supplied account fields before it reads or mutates the Profile registry. The token is neither persisted nor logged.

## Defect-analysis iterations

Round 1 found four defects: outbound values were not runtime-validated, base64url trailing bits were not canonicalized, the Desktop client id reused the Host identity brand, and version negotiation accepted only `[1]`. All four are covered by focused tests.

Round 2 found three protocol gaps: the signed preimage was undefined, a capability response could omit the baseline method, and Host process/installation identities could collapse to the same value. The domain-separated signing vector, required baseline capability, installation public key, positive generations, and distinct-id check close them.

Round 3 found no new package-owned defect. Transport buffering, peer credential checks, cryptographic verification, replay state, and operation payloads remain explicit consumer responsibilities and are named in the package limitations rather than partially implemented here.

Round 4 found four Account-authority defects: token expiry could precede issuance, a required field silently changed the version-1 wire payload, a caller could construct a keyring without the exact parser, and the negative registry-mutation path was not directly observed. Ordered time bounds, the signed capability marker plus legacy `upgrade_required` response, parser-enforced verifier construction, and focused zero-mutation coverage close them.

Round 5 found two reliability defects: direct parser callers had no keyring byte bound, and the startup subpath lacked a source alias even though the bundle patch loads it. The parser owns the same 16 KiB limit as startup, and `tsconfig.base.json` maps the startup export to source. Round 6 found no new defect in token validation, key pinning, rolling compatibility, authorization order, error mapping, or credential retention.

Round 7 found four shared-lifecycle defects: Host identity lacked a restart fence, a connection could issue Profile operations without an environment Session, one connection could cross environments, and a Desktop could kill a newly attached Session after observing a stale zero count. Durable signed Host generation, mandatory connection-bound Session attach, environment equality checks, and installation-owned shutdown close them. Round 8 found no new defect in attach/detach replay, stale-generation rejection, disconnect cleanup, or two-environment coexistence.

## Alternatives considered

**Reuse the SDK JSON-RPC carrier.** It is an agent-runtime stdio protocol that skips malformed lines and does not own installation identity, so it cannot enforce connection-fatal local supervisor authentication.

**Trust the socket path or the returned public key.** Either can be substituted by an untrusted local process. The broker instead requires registry-owned installation trust plus native evidence for the connected executable.

**Let each Slark environment assert Account identity.** A staging or production assertion would make the environment an Account authority and could create different machine Profiles for one person. Both environments instead present the same canonical DSH Account credential to the one Host.

**Stop the Host when detach reports zero active Sessions.** The count can become stale before an external SIGTERM because another environment may attach concurrently. Desktop windows therefore relinquish the Host, while shutdown remains an installation-lifecycle operation.

## Consequences

The protocol deliberately rejects semantically equivalent JSON. This reduces parser differential and cross-language ambiguity, but every implementation must follow the committed golden vectors. A peer advertising a future version can still negotiate down by sending (for example) `[2,1]`; version-1 framing remains the compatibility bootstrap.

Profile creation depends on a live DSH Account session long enough to obtain a valid Host-audience token. This prevents offline environment assertions from creating Profiles, at the cost of requiring Desktop to refresh an expired Account session before retrying `profile.ensure`.

The Host can remain alive after every Desktop window exits. This costs one idle local process and requires update/removal tooling to own bounded shutdown, but it prevents one environment from terminating another environment's work and removes count-based shutdown races.

A decoder receives a complete string, so it can reject an oversized frame but cannot prevent the transport from first buffering it. The Unix-domain-socket carrier must enforce the byte cap incrementally and close on the first error. Invalid input without a trustworthy request id receives no error frame; the connection closes.

## Testing

The focused suite starts from committed request, result, error, and signing-payload vectors and round-trips them byte-for-byte. Negative coverage pins extra and missing fields, whitespace, multiple frames, size overflow, forged outbound data, non-canonical base64url, missing baseline capability, reused identities, future-client downgrade negotiation, malformed or expired Account tokens, and verified Account mismatch before registry mutation. Host integration coverage pins generation allocation across stale-owner recovery, two environments on one Host, exact attach/detach replay, stale permission and Session generations, forbidden same-generation resurrection, cross-environment operation rejection, and disconnect cleanup.
