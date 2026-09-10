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

`profile.ensure` carries a short-lived ES256 access token issued by the canonical DSH Account authority for the `dsh-host` audience. The `profile.ensure_account_token` capability marks this payload revision. A new client refuses to send the revised payload to a Host without the capability, while a new Host still decodes the legacy payload and returns `upgrade_required` before registry access. The Host verifies the exact JWT shape and signature against an owner-private public keyring whose SHA-256 digest is pinned by the embedding release, then requires the verified issuer and subject to equal the Desktop-supplied account fields before it reads or mutates the Profile registry. The token is neither persisted nor logged.

`profile.bootstrap_local`, `profile.restore_local`, and `profile.open_local` own the account-independent local Profile path. Bootstrap accepts only a Main-vault key handle and 32-byte unlock material, and returns the same installation- and generation-bound Host selector as account provisioning. Restore verifies that selector, the local-only Profile kind, its exact generation, and fresh unlock material; open requires that restore or bootstrap unlocked the Profile on the same authenticated connection. These operations never accept or create an Account binding, issuer, subject, token, or environment assertion. Their separately advertised capabilities let a new Desktop report `upgrade_required` before it sends local unlock material to an older Host.

REQ-20260909-0002 adds a third, domain-separated access scope for an existing Account Profile whose cached selector is missing. `profile.recovery_inspect` accepts only opaque key handles enumerated by trusted Desktop Main and performs existing-only persistence, owner-state, manifest, lockfile, plugin-link, and runtime-content inspection without starting a worker or plugin. Native confirmation is followed by `profile.recover_offline_account`; the Host re-runs preflight, verifies the Main-vault unlock material, and grants only `offline_local` to that authenticated connection. `profile.open_offline_account` cannot consume connected or local-anonymous selectors, and `profile.recovery_status` makes a timed-out confirmation idempotently observable. These capabilities are advertised only when both recovery adapters are installed.

Legacy plugin links into an upgrade-replaced application are never used as a silent fallback. After confirmation, the Host copies the complete legacy runtime into an owner-private, content-addressed Profile closure, rewrites only links proven by the preflight plan, verifies the copied tree digest, and records prepared/committed journals. It does not merge Profile directories, create empty owner state, modify account bindings, or require an email login. Desktop keeps the recovery selector in a separate encrypted cache; the durable recovery authority remains the Keychain proof plus Host verifier.

`profile.open` is also the renewal operation for an unexpired lease owned by the same authenticated connection and Profile. Renewal keeps the lease id and generation, advances expiry from the Host clock, and issues a fresh one-use activation handle after the previous handle was consumed. The Desktop refreshes the HttpOnly bootstrap cookie without replacing the active renderer; disconnect, explicit close, Profile generation change, and expiry still revoke the lease.

## Defect-analysis iterations

Round 1 found four defects: outbound values were not runtime-validated, base64url trailing bits were not canonicalized, the Desktop client id reused the Host identity brand, and version negotiation accepted only `[1]`. All four are covered by focused tests.

Round 2 found three protocol gaps: the signed preimage was undefined, a capability response could omit the baseline method, and Host process/installation identities could collapse to the same value. The domain-separated signing vector, required baseline capability, installation public key, positive generations, and distinct-id check close them.

Round 3 found no new package-owned defect. Transport buffering, peer credential checks, cryptographic verification, replay state, and operation payloads remain explicit consumer responsibilities and are named in the package limitations rather than partially implemented here.

Round 4 found four Account-authority defects: token expiry could precede issuance, a required field silently changed the version-1 wire payload, a caller could construct a keyring without the exact parser, and the negative registry-mutation path was not directly observed. Ordered time bounds, the signed capability marker plus legacy `upgrade_required` response, parser-enforced verifier construction, and focused zero-mutation coverage close them.

Round 5 found two reliability defects: direct parser callers had no keyring byte bound, and the startup subpath lacked a source alias even though the bundle patch loads it. The parser owns the same 16 KiB limit as startup, and `tsconfig.base.json` maps the startup export to source. Round 6 found no new defect in token validation, key pinning, rolling compatibility, authorization order, error mapping, or credential retention.

Round 7 reviewed the offline-recovery implementation and found runtime facts that did not bind file contents, silent highest-session candidate selection, pending operations retained across logout, and stale preflight errors hidden as worker failures. Runtime tree digests, explicit native selection, lifecycle reset, and exact stale propagation close them. Round 8 found operation reservation races, revoked-operation retention, unbounded short-lived plans, cross-scope grant replacement, and incomplete cache durability; the Host now reserves before asynchronous reinspection, prunes owner/candidate state, replaces Profile plans, rejects scope changes, and fsyncs private cache updates.

Round 9 followed the product path across Web, Main, daemon, and Host. It found unconditional capability advertisement, unreadable vaults reported as conflicts, mapped errors collapsing into generic workbench failure, and the Web entry invoking Account binding before local recovery. Capabilities now reflect installed adapters, missing and unreadable vaults are distinct, stable recovery errors have actionable copy, and existing local data is opened before any optional Account flow. Round 10 fixed mapped `not-found` handling across multiple legacy vaults, mapped a failed timeout status into the Desktop error domain, and removed `existsSync` filtering that hid permission failures. Round 11 found that internal absolute links were rewritten toward the staging directory and broke after atomic rename; links now target the final content-addressed root and the tree is verified both before and after rename. Round 12 found dangling internal links and lexical in-root links whose final target escaped through another symlink; recovery now resolves every final target and requires it to remain in the runtime closure.

## Alternatives considered

**Reuse the SDK JSON-RPC carrier.** It is an agent-runtime stdio protocol that skips malformed lines and does not own installation identity, so it cannot enforce connection-fatal local supervisor authentication.

**Trust the socket path or the returned public key.** Either can be substituted by an untrusted local process. The broker instead requires registry-owned installation trust plus native evidence for the connected executable.

**Let each Slark environment assert Account identity.** A staging or production assertion would make the environment an Account authority and could create different machine Profiles for one person. Both environments instead present the same canonical DSH Account credential to the one Host.

**Close and reopen the lease in Desktop.** Closing first creates an authorization gap and may stop the Profile view origin, which replaces the renderer and loses in-progress UI state. Repeating the authenticated `profile.open` operation extends the existing lease atomically inside the Host.

**Forge a replacement selector or reclassify the Account Profile as local.** Either bypasses Host authority and can conflate Account, local-anonymous, and offline access. Recovery instead proves the existing registry verifier and mints a selector in the separate `dsh-profile-offline-selector/v1` domain.

**Merge the old Profile directory into the newly created local Profile.** Session and plugin state have independent generations and ownership. Directory copying would make rollback and provenance ambiguous, so the original Profile is opened in place and only its external runtime dependency closure is materialized privately.

## Consequences

Account provisioning captures the prior Profile record and applies registration without an asynchronous gap. Worker failure restores that record only while the registered object is still current; a concurrent change returns `stale`. Looking up only the target identity cannot identify the prior record during issuer or subject replacement, so rollback belongs to the registry rather than the Desktop Host caller. Missing worker support rejects before mutation. This preserves local registry metadata, not a distributed cloud-migration transaction; process-loss recovery and cloud authorization require separate coordination.

The protocol deliberately rejects semantically equivalent JSON. This reduces parser differential and cross-language ambiguity, but every implementation must follow the committed golden vectors. A peer advertising a future version can still negotiate down by sending (for example) `[2,1]`; version-1 framing remains the compatibility bootstrap.

Account-backed Profile creation depends on a live DSH Account session long enough to obtain a valid Host-audience token. The local-only Profile path is independent of that session and remains unavailable only when the trusted Host, Keychain material, or local worker is unavailable. An expired Account token affects only a later account-backed `profile.ensure` retry.

An active Desktop renews its one-minute view lease periodically. The Host keeps expiry authoritative and extends only an unexpired lease owned by the same authenticated connection and Profile; an inactive or disconnected Desktop cannot create an immortal lease.

Local Account Profile recovery is intentionally independent of Slark login, environment routing, and DSH Account email verification. Logout revokes connection grants and clears reconnect selectors, but does not delete the Main vault or Profile data; a later connection can prove them again. `offline_local` enables local sessions and installed plugins only. Cloud sync and connected capabilities still require a separate online authorization transition and cannot be inferred from a matching email.

A decoder receives a complete string, so it can reject an oversized frame but cannot prevent the transport from first buffering it. The Unix-domain-socket carrier must enforce the byte cap incrementally and close on the first error. Invalid input without a trustworthy request id receives no error frame; the connection closes.

## Testing

The focused suite starts from committed request, result, error, and signing-payload vectors and round-trips them byte-for-byte. Negative coverage pins extra and missing fields, whitespace, multiple frames, size overflow, forged outbound data, non-canonical base64url, missing baseline capability, reused identities, future-client downgrade negotiation, malformed or expired Account tokens, and verified Account mismatch before registry mutation. Host lifecycle coverage proves that reopening an activated lease preserves its id and generation while advancing expiry and rotating its one-use activation handle, and that a local Profile can bootstrap, reconnect, restore, and open without Account credentials.

Offline recovery coverage proves scope separation, unique handle resolution, read-only missing-root behavior, second-preflight staleness, operation idempotency, disconnect revocation, conditional capability advertisement, multi-vault selection, mapped not-found continuation, unreadable-vault reporting, and timeout status mapping. Runtime fixtures prove legacy closure copy, content digest verification, final-root absolute-link rewriting, atomic publication, recovery journal completion, and rejection of broken, escaping, special-inode, or unsafe dependencies. The focused recovery inspector is held at 100% statements, branches, functions, and lines; the actual legacy Profile is inspected read-only before any user-approved materialization.
