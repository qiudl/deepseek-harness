---
description: "Strict canonical wire frames for Desktop-to-DSH-Host identity negotiation and control errors."
kind: "package-reference"
---

# dsh-host-control-protocol

English | [中文](README.zh.md)

## Summary

This zero-I/O library owns the local control wire shared by the Desktop broker and the single DSH Host supervisor. Version 1 starts with a signed `host.inspect` challenge exchange and includes account and local-only Profile operations, leases, and migration-export payloads. Later operations must retain this package's canonical JSON-Lines envelope, branded identities, bounded frame, and sanitized error vocabulary.

The transport is not JSON-RPC. A malformed line is a connection-fatal protocol violation rather than input to skip.

## Table of Contents

- [Wire contract](#wire-contract)
- [Challenge authentication](#challenge-authentication)
- [API](#api)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Wire contract

- One UTF-8 JSON object and one final LF per frame; CRLF, extra lines, duplicate or reordered keys, unknown fields, non-canonical numbers, and trailing data are rejected.
- The JSON object is at most 65,536 UTF-8 bytes, excluding LF. The transport must enforce the same cap while buffering; this string codec cannot undo bytes already accumulated by a caller.
- UUIDs are lower-case RFC variants. Nonces and Ed25519 material use canonical unpadded base64url. SHA-256 digests use lower-case hexadecimal.
- Capability names are sorted, unique dotted tokens and must include `host.inspect`. Unknown negotiated methods are refused explicitly.
- Errors expose only a stable code, retryability bit, and correlation id. Exception messages and local paths never enter a frame.

The negotiated `profile.extensions` method carries a Main-held lease and one inventory, prepare, commit, status, or cancel command. Prepare payloads are limited to 32,768 UTF-8 bytes; results contain only plans, bounded metadata, or durable receipt states. Plugin completion actions must be literal `install`, `update`, or `remove` strings; arrays and objects are rejected without coercion. Kind support belongs to the Host executor, so a decoded kind is not proof that installation is available. Skill inventory may include the boolean `skill_archives`; absence means that the caller cannot assume archive support. Archive plans carry URL and digest metadata within the same payload limit, not ZIP bytes.

`profile.model_claim_inventory` carries a Main-held Account view lease and returns a source digest, at most 128 distinct provider candidates, credential presence, shared-reference flags, and counts of unmapped records. The codec rejects credential values, reference names, paths, and additional fields. This read-only inventory is not a claim confirmation or credential transfer authority.

`profile.model_claim_confirm` rechecks the Account lease and a fresh source digest for one candidate with a present credential. It returns a one-use confirmation bound to the current Host connection and valid for 60 seconds. `profile.model_claim_apply` consumes that confirmation and rechecks the Account view through the claim transaction. Both results omit credential values and paths. A failed or interrupted write uses the separate same-Account recovery methods.

`profile.model_claim_retry` accepts the same fresh Account and vault proof as recovery, plus the exact candidate, operation id, and source digest from an existing receipt. The Host checks durable ownership before resuming the transaction. It is available only while the legacy source has been declared quiescent; status and preimage restoration remain available without that declaration.

`profile.model_claim_recovery_inventory` accepts the same proof without a candidate id. It returns at most 128 distinct, secret-free receipts for the authenticated Account's pending claims and uncleared Profile marker. This query does not open the worker or grant a new claim.

## Challenge authentication

`encodeHostInspectSignaturePayload(request, response)` returns the exact UTF-8 bytes signed with the installation Ed25519 key. The domain-separated statement binds the request id, Desktop client id, challenge, selected version, Host and installation ids, installation public key, generations, process nonce, capabilities, and executable digest.

The public key in an answer is not trust by itself. The Desktop broker must match it to its authenticated installation record and independently compare the peer executable's code-signing digest before accepting the signature. A migration flow may establish that record only through its explicit consent and verification policy; ordinary connection must never silently trust a new key.

## API

| Export | Role |
|---|---|
| `decodeHostControlFrame(source)` | Strictly parse and normalize exactly one frame. |
| `encodeHostControlFrame(frame)` | Runtime-validate and emit exactly one canonical frame. |
| `encodeHostInspectSignaturePayload(request, response)` | Produce the domain-separated signing bytes pinned by the golden vector. |
| `HostControlProtocolError` | Sanitized local failure with a stable code. |
| `HOST_CONTROL_MAX_FRAME_BYTES` | Shared transport buffering ceiling. |

## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

See the [single Host control protocol Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-single-host-control-protocol.md).

</details>

## Runtime invariants

No runtime invariant companion is published: the codec validates the complete wire value algebra at its input boundary.

## Model Experience

None, as this local Host control codec registers nothing model-facing.

#### KV Cache effect

No direct invalidation; the protocol never contributes model context.

## Known Limitations and Deferred Work

- **Operation set is bounded** — version 1 decodes `host.inspect`, account and local-only Profile provisioning/restore/open, Profile status/lease-close, migration export begin/read, extension commands, and common errors. Environment, session, approval, and upgrade operations require explicit protocol additions.
- **Transport enforcement is external** — the Unix-domain-socket carrier must stop reading at the byte cap and close on the first codec failure.
- **Cryptographic policy is external** — key persistence, code-signature inspection, challenge signing and verification, replay storage, and key rotation belong to the Host identity and Desktop broker packages.

MCP inventory may advertise `mcp_remove: true` and `mcp_update: true`; absence means the corresponding operation is unavailable. Both flags are boolean and valid only for MCP inventory.

Skill inventory may include `skill_invocation: true` and paired boolean entry fields `model_invocable`/`user_invocable`. Missing capability disables editing; missing entry flags mean unknown local policy. Invocation fields are valid only on Skill inventory and never carry instruction content or paths.

Skill inventory may advertise boolean `skill_files` for confirmed Markdown imports. Absence means unsupported. Original Markdown is carried inside the bounded JSON prepare payload, never as an arbitrary local path or archive upload.

Skill inventory may advertise boolean `skill_replace` for explicitly confirmed replacement of one existing flat/bundle entry. The bounded prepare payload contains an entry ID and Markdown; replacement is separate from new-file import and never accepts a filesystem path.

`skill_remove` is an optional boolean restricted to Skill inventory. A successful removal receipt may contain `skill_source` after the optional reason field: `absent`, `user-dsh`, `user-agents`, `custom`, `bundled`, `runtime`, or `other`. This reports the default-preset observation at completion; it is not a live source inventory. Existing receipts without the field remain readable. Paths, instruction content and arbitrary source strings are not returned.

Plugin inventory may advertise boolean `plugin_toggle` and optional per-entry `plugin_state`: `enabled`, `disabled`, `mixed`, or `unsupported`. Both fields are invalid on other markets. State refers to composition policy rather than live health; successful mutation receipts still require worker acknowledgement. Missing capability or entry state disables Desktop controls.

Plugin inventory additionally advertises optional boolean `plugin_update` and `plugin_remove`; both are invalid on other markets. Desktop update requires an enabled managed row and an immutable same-name preflight result. Removal accepts enabled, disabled or mixed independently managed rows. Absence of either capability keeps its control disabled. These actions use the existing Profile-bound prepare/commit/receipt contract.

Plugin inventory entries use opaque package IDs and bounded npm package names, including scoped names; MCP and Skill inventory labels retain their restricted character set.

Skill entries may carry paired `skill_source` and `skill_status` fields after invocation fields, followed by `effective_source` only for `shadowed` entries. Sources are restricted to `user-dsh`, `user-agents`, `custom`, `bundled`, `runtime`, and `other`; status is `effective`, `shadowed`, or `not_visible`. These fields are exclusive to Skill inventory, contain no paths, and are distinct from the completion-time source on a removal receipt.

Unknown Skill-removal receipts may advertise `skill_restore` containing a bounded flat/bundle entry ID. Unknown MCP receipts may instead advertise `mcp_restore: true`. Plugin activation receipts may advertise `plugin_restore` containing a bounded npm package name. All recovery capability fields are omitted for unsupported or already-recovered operations and are mutually exclusive. `restored_by` links an unknown historical receipt to the successful recovery UUID; it is mutually exclusive with either recovery capability. Recovery receipts carry `restores_operation` identifying the original operation. Neither link may equal the receipt’s own operation ID. The canonical optional order after `skill_source` is `skill_restore`, `mcp_restore`, `plugin_restore`, `restored_by`, then `restores_operation`; private checkpoint hashes and filesystem paths are not transmitted.

An unknown package receipt can expose `plugin_complete` with closed `action`, `package_name`, and optional `spec` fields. Actions are install/update/remove; install and update require a bounded source, while remove omits it. The capability is mutually exclusive with restoration capabilities and successful-resolution links. Completion uses distinct `completed_by` and `completes_operation` UUIDs, rejecting self-links and corresponding restoration-link combinations. Canonical receipt order adds `plugin_complete` after `plugin_restore`, then `restored_by`, `restores_operation`, `completed_by`, and `completes_operation`. Intent stages, original dependency hashes and unrelated-state digests remain Host-private.
