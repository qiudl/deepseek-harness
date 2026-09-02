---
description: "Machine-local single DSH Host authority and authenticated Unix transport for trusted Desktop brokers."
kind: "package-bundle"
---

# dsh-desktop-host

English | [中文](README.zh.md)

## Summary

This package owns the machine-local DSH Host authority used by Desktop Main. It keeps issuer-qualified Person Profiles outside Slark environments, serializes same-session commands, fences approvals and environment context leases, supervises isolated Profile workers, and exposes an owner-only authenticated Unix socket. The Host control component owns no HTTP listener. Its product composition starts the existing `dsh web` worker, exchanges the one-use launch URL itself, and returns only a verified loopback origin plus an HttpOnly cookie name/value to trusted Main; neither the launch token nor a filesystem path reaches Renderer.

`discoverUnixHost` reports `running`, `stopped`, or `unknown`. Only a registry-owned endpoint with no listening process is `stopped`; failed UID, installation-key, executable-signature, challenge, frame, or socket-shape verification is `unknown`.

## Table of Contents

- [Desktop adapter](#desktop-adapter)
- [Profile and execution authority](#profile-and-execution-authority)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Desktop adapter

`UnixHostClient` exposes Profile ensure/restore/status/open/view-activation/close operations and owner-only migration operations. Every operation accepts an `AbortSignal`. Aborting destroys the authenticated connection, and the Host revokes every view lease and Profile unlock reference owned by that connection. Another staging or production connection that independently proved the same Profile remains authorized.

The connection starts with `host.inspect`: Desktop supplies a fresh challenge and verifies the installation Ed25519 signature, trusted installation id and key, peer UID, executable signature digest, Host process nonce, and runtime generation. Later frames repeat the client, Host, and process identities and carry a 30-second-bounded single-use JTI.

## Profile and execution authority

The Profile registry stores a device-keyed HMAC of canonical DSH Account issuer plus opaque subject, an opaque Profile id, environment-scoped current binding handles and versions, and an opaque Keychain handle. Staging and production bindings for the same person resolve to one Profile; a higher server-signed binding version atomically replaces only that environment's old handle and invalidates older signed selectors. Raw account identity and the 32-byte Main-vault unlock material are absent from the file: only a domain-separated verifier is durable, and successful constant-time verification authorizes the current authenticated connection.

`profile.ensure` returns a Host-signed opaque selector bound to the installation, Profile, binding generation, runtime generation, and schema generation. `profile.restore` accepts that selector, the exact Keychain handle, and fresh Main-vault material. Copying a selector to another installation, replaying it after a binding rotation, guessing a handle/material, or disconnecting the proving connection fails closed.

The macOS startup composition validates owner-only non-symlink roots, starts exactly one Host, checks the Node executable and fixed DSH entrypoint independently, performs native peer PID/executable/code-signature attestation, and publishes the exact secret-free `~/.dsh/host/registration.v1.json` discovery record. Profile workers inherit no ambient environment. The Host verifies the child owns its reported loopback listener, exchanges its one-use launch token for a signed cookie, confirms unauthenticated `/` is 401 and authenticated `/` is 200, then discards the token.

Command writes serialize by Profile and Session, while different Sessions can proceed concurrently. The fsync-backed journal records `started` before execution and a committed outcome afterward; a crash between them recovers as `unknown`, never success. Approval decisions compare payload hash, decision version, window generation, and expiry. Environment context attaches to a Session lease and never becomes Profile-global state.

## Model Experience

None, as this package exposes no model-facing registration.

#### KV Cache effect

No direct invalidation; Host control facts do not enter model context.

## Known Limitations and Deferred Work

- **Unlock material remains embedding-owned** — Slark Main must keep the random 32-byte Profile material in macOS Keychain/safeStorage and provide it only across the authenticated Main-to-Host path. It must never enter Renderer, argv, environment, logs, or the registration file.
- **Legacy migration is fail-closed until complete** — the Host advertises export only when the active Profile's complete owner-only bundle (sessions, settings, credentials, workspace and Profile configuration) can be staged. A digest-only or session-only transfer is not advertised as a safe migration.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

See the [single Host control protocol Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-single-host-control-protocol.md).

</details>
