# Agent Note: encrypted WebWorker local profiles

Status: implemented

English | [中文](2026-09-10-encrypted-webworker-local-profiles.zh.md)

## Problem

A browser-hosted Harness needs a durable local workspace without making a Slark login, email binding, cloud workspace, or Desktop installation a prerequisite. The WebWorker VFS was memory-only, and its optional fixture overlays were static startup input rather than user-owned storage. Persisting plaintext would expose conversations and workspace files to anyone who can read the origin database. Persisting a data key beside its ciphertext would add encryption syntax without protecting the data. A local profile also needs one writer, exact environment isolation, and explicit behavior when browser durability is unavailable.

## Decision

**The DSH origin owns each browser-local profile.** The page creates or unlocks the profile and passes its non-extractable AES-256-GCM data key to the same-origin dedicated Worker through structured clone. Slark may select a mode or hand off an optional online connection, but its origin does not own the profile database or key material. `environmentId` and a UUID `profileId` form the storage namespace and bind the key wrapper, profile key check, Web Lock, and every file ciphertext; Staging and Production never reuse a namespace or silently fall back to one another.

**Independent passkey and recovery wrappers protect the random data key.** Enrollment first derives an AES-KW key from a normalized recovery passphrase through versioned PBKDF2-HMAC-SHA-256 parameters, then requires user verification and requests the WebAuthn PRF extension. The PRF output derives another non-extractable AES-KW key through HKDF. Both keys wrap the same fresh AES-GCM data key, and the origin registry stores only strict wrapper metadata. WebAuthn permits registration to report PRF support without returning an evaluation, so enrollment immediately requests an assertion for the new credential in that case. Either unlock path requires the caller's expected environment and profile identifiers; passkey unlock also requires user verification and the exact credential. IndexedDB never receives an unwrapped key.

**Recovery transfer is complete, authenticated, and atomic.** The registry, VFS key-check record, and encrypted entries share one versioned IndexedDB database. New-profile initialization commits its registry record and key check together; export reads a consistent snapshot, and import commits all stores in one transaction. A recovery pack keeps only the recovery wrapper and environment/profile header outside, then encrypts and authenticates the complete snapshot with the profile data key. Import validates the user-selected environment before key derivation, authenticates the pack, checks the embedded VFS key record, and refuses any existing registry, profile, or entry rather than merging or overwriting it. The current in-memory JSON format has an explicit 256 MiB serialized limit.

**Durable VFS state is a restricted encrypted overlay.** The Worker asks the Storage API for persistence and acquires an exclusive Web Lock before opening IndexedDB. It mirrors only canonical paths under `/dsh/home` and `/dsh/workspace`; runtime modules, configuration, and temporary files remain image or session state. Every file and directory record is encrypted, and AES-GCM additional data authenticates its namespace, format version, path, kind, mode, modification time, and optional hard-link group. A complete hard-link set commits in one IndexedDB transaction and hydrates as one file identity over the immutable image and selected fixture overlays before Cordis boots.

**Local readiness is independent from online readiness.** No selected profile, denied persistent storage, an unavailable database, or a missing Web Lock yields an explicit `session_only` result and the in-memory Harness still starts. A profile already open by another tab, an invalid key, or corrupt profile metadata fails closed with a distinct reason code. A write-behind failure stops further mirroring and preserves the live in-memory session. Worker startup failure and normal disposal release the Web Lock; normal disposal first lets the Cordis tree stop and flushes queued VFS writes.

**Product activation requires the remaining presentation owners.** The preview passes no `localProfile`. The encrypted primitives remain dormant until the DSH origin supplies first-run and migration UI, live post-boot downgrade notification, and browser E2E for the registry, recovery path, and a real PRF-capable authenticator. This prevents an incomplete storage path from silently creating or taking over user data.

## Alternatives considered

**Store a `CryptoKey` in IndexedDB beside the ciphertext.** A same-origin database reader would receive both the ciphertext and the key needed to decrypt it. Non-extractability limits JavaScript key export but does not prevent an origin script from invoking `subtle.decrypt`, so this does not provide the intended at-rest separation.

**Store the local profile in the Slark origin.** The DSH Worker cannot read another origin's IndexedDB, and granting Slark ownership would make local data lifecycle depend on the optional account layer. The DSH origin owns storage; cross-origin integration carries only explicit mode and connection handoff.

**Require cloud bootstrap before opening local DSH.** This recreates the failure in which expired login, missing email binding, cloud provisioning, capacity, or an account allowlist disables a usable local runtime. Online services remain optional capability additions.

**Allow concurrent tabs and reconcile last-write-wins.** Session logs, atomic file replacement, rename, and hard links do not share one safe merge rule. One exclusive writer rejects a second tab instead of silently losing either tab's work.

**Persist the complete mounted image.** Runtime code and configuration are deployment-owned and replaceable on upgrade. Persisting them would mix executable state with user data, enlarge migrations, and permit stored code to shadow a signed image.

## Consequences

The browser runtime can restore encrypted local user data without a Slark session, while an unavailable durability feature degrades only persistence and never becomes an account or personal-workspace error. Strict namespaces, canonical paths, and authenticated metadata make cross-environment reuse, path traversal, and metadata tampering fail closed. The single-writer rule costs simultaneous editing of one profile in several tabs. A user can unlock the random data key with either configured wrapper and can transfer the full encrypted profile through an authenticated recovery pack without a cloud account. Unit tests cover dual key wrapping, recovery-pack round trips and rejection paths, strict parsing and registry records, environment separation, storage degradation, locking, encrypted hydration, metadata tampering, ordered removal, and hard-link identity; the built preview smoke covers the unchanged session-only startup path.
