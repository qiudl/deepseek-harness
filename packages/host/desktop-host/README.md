---
description: "Machine-local single DSH Host authority and authenticated Unix transport for trusted Desktop brokers."
kind: "package-bundle"
---

# dsh-desktop-host

English | [中文](README.zh.md)

## Summary

This package owns the machine-local DSH Host authority used by Desktop Main. It keeps issuer-qualified Person Profiles outside Slark environments, serializes same-session commands, fences approvals and environment context leases, supervises isolated Profile workers, and exposes an owner-only authenticated Unix socket. The Host control component owns no HTTP listener. Its product composition starts the existing `dsh web` worker, exchanges the one-use launch URL itself, and returns only a verified loopback origin plus an HttpOnly cookie name/value to trusted Main; neither the launch token nor a filesystem path reaches Renderer.

## Table of Contents

- [Desktop adapter](#desktop-adapter)
- [Profile and execution authority](#profile-and-execution-authority)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Desktop adapter

The pinned native helper creates its default loader only after validating the exact addon path and bytes. Importing that helper does not resolve a native package. The private `windows-startup.js` composition passes the same release pin to its parent SID, registration, listener, and cancellation adapters and includes it in strictly decoded Worker boot data. The file Worker independently revalidates and loads that exact addon for cancellation, pipe I/O, lifecycle, and peer attestation. Neither production path searches the Koffi package; the embedding must still verify release metadata and protect the installed files throughout use.

Windows directory security evidence preserves generic, standard, and file-specific SDDL rights as unsigned masks. Unknown tokens and masks wider than 32 bits reject inspection. Parsing generic rights does not grant private-storage access: private files still require the exact protected three-principal file-full-control DACL.

The startup artifact exposes `loadWindowsLegacySourceProbe` for trusted embedding code. Assembly resolves the current process SID through the same release-pinned native addon as local-vault storage, performs no legacy filesystem inspection, and returns only a read-only probe. Unsupported platforms, missing pins, native identity failures, or a missing directory inspector reject loading. The embedding must protect the addon throughout later probe calls and supply the OS-selected user home.

The Windows native directory inspector reads existing-path attributes and security evidence without creating directories or repairing permissions. Missing paths, denied access, sharing conflicts, and inspection failures throw. Its evidence does not authorize migration or prove ancestor safety after the read handle closes; complete legacy inventory remains separate.

The legacy-home metadata probe distinguishes an observed missing `.dsh` leaf from an existing directory or an unknown result. It inspects ancestors first, rejects redirected paths and foreign user-home ownership, and treats empty existing homes as present without reading their contents. Only the native leaf-open file-not-found error produces observed absence; no result admits migration or replacement creation. Source enumeration, schema checks, and stable-tree verification remain required.

`discoverUnixHost` reports `running`, `stopped`, or `unknown`. Only a registry-owned endpoint with no listening process is `stopped`; failed UID, installation-key, executable-signature, challenge, frame, or socket-shape verification is `unknown`.

Windows local Profile storage accepts embedding-encrypted envelopes up to 16 KiB. It reuses native SID/DACL and reparse checks, requires a verified file lease for replacement, and releases the lease after synchronous callbacks, including failures. Missing files return null; permission and integrity failures do not authorize a new identity. Native assembly requires one canonical, singly linked Koffi addon and its independently release-verified SHA-256; it never searches alternate packages or paths. The embedding owns encryption, environment-root selection, and protection against addon replacement throughout loading and use. Digest checks alone do not prove Windows installation ACLs or publisher signatures; native installation validation remains required.

The Windows client uses a private file-backed Worker to attest the connected pipe server before sending Host frames. Its Bun Main cancellation adapter is supplied by this package through the verified client artifact; callers provide the release-pinned Worker and publisher anchors. Worker exit must be confirmed before its transferred thread handle is closed. Windows distribution remains subject to signed-carrier and native installation validation.

Windows Host startup converts canonical absolute Worker paths with Windows file-URL rules, preserving Unicode, spaces, literal percent signs, and hash characters in installation directories.

Client cancellation retains a thread handle transferred after startup cancellation. If the cancellation retry budget expires, the parent retains the handle until a later normal or failed Worker exit confirms it can be closed; exhausting the budget does not prove shutdown.

`UnixHostClient` exposes Profile account ensure/restore/status/open, local bootstrap/restore/open, view-activation/close, and owner-only migration operations. The local operations accept no account identity, token, binding, or environment assertion; the Host selector plus Keychain material restores the local-only Profile on a later authenticated connection. Reopening the same Profile from its authenticated owner atomically extends the existing short-lived view lease and issues a fresh one-use activation handle, so an active Desktop can renew authorization without replacing its renderer. The `profile.ensure_account_token` capability marks a Host that accepts the token-bearing `profile.ensure` payload; either peer reports `upgrade_required` before mutation when that capability is absent. `profile.ensure` requires a short-lived canonical DSH Account token with the `dsh-host` audience; the Host verifies it offline and requires its issuer and subject to match the requested account before any Profile registry mutation. Every operation accepts an `AbortSignal`. Aborting destroys the authenticated connection, and the Host revokes every view lease and Profile unlock reference owned by that connection. Another staging or production connection that independently proved the same Profile remains authorized.

The connection starts with `host.inspect`: Desktop supplies a fresh challenge and verifies the installation Ed25519 signature, trusted installation id and key, peer UID, executable signature digest, Host process nonce, and runtime generation. Later frames repeat the client, Host, and process identities and carry a 30-second-bounded single-use JTI.

## Profile and execution authority

Account provisioning preserves the exact prior registry row when worker preparation fails, including an issuer or subject replacement. A concurrent registry change prevents rollback and returns `stale`. A missing worker provider rejects before registration. These rules affect registry metadata only; they neither authorize a cloud identity migration nor move or delete Profile content.

Adding an account binding after restoring a row without the optional binding field writes the canonical registry field order, so the updated row remains readable after Host restart.

The Profile registry stores an opaque Profile id, opaque Keychain handle, and domain-separated unlock verifier for every Profile. Account Profiles also store a device-keyed HMAC of canonical DSH Account issuer plus opaque subject and environment-scoped current binding handles and versions; staging and production bindings for the same person resolve to one account Profile. Local-only Profiles use a device-keyed random index and never gain an account binding. A higher server-signed binding version atomically replaces only that environment's old account handle and invalidates older signed selectors. An Account issuer replacement preserves the existing Profile only when the request carries that same environment binding handle, a strictly higher version, the same Keychain handle, matching unlock material, and a valid token for the replacement identity. Raw account identity and the 32-byte Main-vault unlock material are absent from the file, and successful constant-time verification authorizes only the current authenticated connection.

`profile.ensure` returns a Host-signed opaque selector bound to the installation, Profile, binding generation, runtime generation, and schema generation. `profile.restore` accepts that selector, the exact Keychain handle, and fresh Main-vault material. Copying a selector to another installation, replaying it after a binding rotation, guessing a handle/material, or disconnecting the proving connection fails closed.

The macOS startup composition validates owner-only non-symlink roots, starts exactly one Host, checks the Node executable and fixed DSH entrypoint independently, verifies the Account public keyring against the embedding release's SHA-256 pin, performs native peer PID/executable/code-signature attestation, and publishes the exact secret-free `~/.dsh/host/registration.v1.json` discovery record. After acquiring exclusive Host ownership, a runtime upgrade may atomically refresh only that record's executable signature digest; every installation, key, endpoint, and socket field must remain identical. Profile workers inherit no ambient environment. The Host verifies the child owns its reported loopback listener, exchanges its one-use launch token for a signed cookie, confirms unauthenticated `/` is 401 and authenticated `/` is 200, then discards the token.

Command writes serialize by Profile and Session, while different Sessions can proceed concurrently. The fsync-backed journal records `started` before execution and a committed outcome afterward; a crash between them recovers as `unknown`, never success. Approval decisions compare payload hash, decision version, window generation, and expiry. Environment context attaches to a Session lease and never becomes Profile-global state.

## Model Experience

None, as this package exposes no model-facing registration.

#### KV Cache effect

No direct invalidation; Host control facts do not enter model context.

## Known Limitations and Deferred Work

- **Unlock material remains embedding-owned** — Slark Main must keep the random 32-byte Profile material in macOS Keychain/safeStorage and provide it only across the authenticated Main-to-Host path. It must never enter Renderer, argv, environment, logs, or the registration file.
- **Account access remains session-bound** — Slark Main must obtain the `dsh-host` token from DSH Account and provide it only across the authenticated Main-to-Host path. The Host does not persist or log this credential; an expired token requires Slark Main to refresh the Account session before `profile.ensure` can succeed.
- **Legacy migration is fail-closed until complete** — the Host advertises export only when the active Profile's complete owner-only bundle (sessions, settings, credentials, workspace and Profile configuration) can be staged. A digest-only or session-only transfer is not advertised as a safe migration.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

See the [single Host control protocol Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-single-host-control-protocol.md).

REQ-20260911-0004 native-storage evidence is limited to an isolated Windows 11 x64 administrator probe with synthetic envelopes: create, read, reopen, competing-lease rejection, replacement, and oversize-write preservation passed. SID decoding uses the LPWSTR output slot; file creation uses a typed security-attributes pointer; repeated loading uses an anonymous structure. Standard-user installation, encryption, signed-carrier integration, and full Desktop startup remain unverified by this probe.

</details>
