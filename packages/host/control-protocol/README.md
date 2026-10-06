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

`profile.remote_session` binds a closed Session and approval command set to one Main-held view lease. Each command carries a separate UUID idempotency key; it cannot select an HTTP path, Profile root, credential, cookie, launch token, or arbitrary method. Prompt text, identifiers, titles, wait intervals, cursors, JSON depth, node counts, strings, and the complete frame are bounded. Decoding this method does not make it available: the Host must advertise its capability only after installing the lease-authorized worker executor.

The `profile.remote_session.control_lease` capability adds exact `control.status`, `control.acquire`, `control.renew`, and `control.release` commands. The selected Profile issues a process generation and per-Session epoch; every remote Session mutation and approval reply carries that claim. The Profile rejects a stale or absent claim before invoking business code, and takeover waits while an admitted write remains active. A Profile restart changes the generation and invalidates old claims.

`profile.remote_ui_read` binds boot, asset, Session, and five exact startup metadata reads to the same live view lease. The boot read and zero-argument startup reads require empty `args`; `credentials/describe` accepts at most 64 validated references and returns status, never values. `asset/read` accepts only a plugin URL and byte offset; `asset/describe` accepts only a plugin URL up to 4096 characters and returns its SHA-256 and length. The Host worker serves or describes only URLs currently named by the startup rows. No request can name a Profile path, cookie, worker token, arbitrary URL, or mutating Gateway method. Each result remains below the 64 KiB control-frame limit. The Host advertises this capability only with a worker executor installed. `session/collaborationSources` accepts only `{ request: { sessionId, cursor? } }`; the cursor is an immutable SHA-256 snapshot digest. The owning worker returns one complete original message per control read with at most60 KiB of JSON; continuation uses that message's digest without truncating text.

`profile.remote_ui_stream` binds one `session/follow` cursor to the same live view lease and Host connection. Open accepts only validated Session or subagent addresses and optional bounded follow arguments. Poll returns immediately with idle, a base64url chunk of at most 16 KiB, or a detail-free terminal state; close cancels the worker reader. The Host never buffers more than one 512 KiB event per cursor and limits each connection to eight cursors. Every command rechecks the lease; a request after lease revocation or connection loss closes the affected cursors. The method does not grant a general Gateway stream or expose the worker token.

`profile.model_claim_inventory` carries a Main-held Account view lease and returns a source digest, at most 128 distinct provider candidates, credential presence, shared-reference flags, and counts of unmapped records. The codec rejects credential values, reference names, paths, and additional fields. This read-only inventory is not a claim confirmation or credential transfer authority.

`profile.model_claim_confirm` rechecks the Account lease and a fresh source digest for one candidate with a present credential. It returns a one-use confirmation bound to the current Host connection and valid for 60 seconds. `profile.model_claim_apply` consumes that confirmation and rechecks the Account view through the claim transaction. Both results omit credential values and paths. A failed or interrupted write uses the separate same-Account recovery methods.

`profile.model_claim_retry` accepts the same fresh Account and vault proof as recovery, plus the exact candidate, operation id, and source digest from an existing receipt. The Host checks durable ownership before resuming the transaction. It is available only while the legacy source has been declared quiescent; status and preimage restoration remain available without that declaration.

`profile.model_claim_recovery_inventory` accepts the same proof without a candidate id. It returns at most 128 distinct, secret-free receipts for the authenticated Account's pending claims and uncleared Profile marker. This query does not open the worker or grant a new claim.

## Challenge authentication

`profile.workspace_model_selection` accepts a verified Account binding, workspace registry UUID and Session id. Its exact result contains those identities, provider/model (up to 256 UTF-8 bytes each), and optional reasoning effort (up to 128 bytes). Caller-selected models, Profile paths and extra response fields are rejected. The result is a read-only choice, not an executable adapter snapshot or Source proof; availability requires an advertised Host executor.

`profile.collaboration_registration` signs a server registration request/challenge ID, canonical nonce, expiry, HTTPS audience, environment UUID and Account issuer/subject after checking the same connection’s verified binding. The assertion includes the installation UUID/public key and current Host instance/process nonce. The Ed25519 payload is the UTF-8 domain `dsh-collaboration-host-registration/v2` plus NUL and a fixed-order JSON tuple; the signature is excluded. Parsing freezes exact fields and rejects credentials. Challenges must remain valid and expire within five minutes. The server must separately trust the installation key, persist/consume its challenge and commit a registration receipt; the signature does not authorize Source or tasks.

`profile.workspace_authority` signs a server nonce, Account/environment and registry workspace/Session target only after the authorized Profile reader confirms membership. It rechecks Account authority and five-minute expiry after the read. The separate `dsh-collaboration-workspace-authority/v1` signing domain binds the complete target and current installation/process; registration signatures cannot substitute. This proves membership at the read, not Source content, journal durability or prepared model configuration. The server must authenticate and atomically consume its challenge with current Host/Account checks.

`profile.source_snapshot` privately reads an existing Source under the verified Account binding and exact workspace/Session/message/revision. The request adds issuer/subject and a byte offset. Each result contains the original descriptor, offset, total length (at most 1 MiB), and a canonical base64url chunk of exactly the remaining bytes up to 32 KiB. The existing 64 KiB frame limit stays unchanged. The client bounds the whole read to 15 seconds, pins the current peer and descriptor across chunks, and decodes complete UTF-8 before validating the opaque eight-field Source capsule. Source consumers validate nested content; cloud sealing and Native signing authenticate the full digest. No model is prepared or executable call returned.

`profile.model_text` accepts an Account binding already verified on the same Host connection and one nonempty text input of at most 8 KiB. It does not open or change a visible Profile view lease. A complete result contains the selected provider, model, and at most 16 KiB of answer text; a rejected result contains one classified code, including distinct `cancelled` and `timeout` outcomes. The method carries no API Key, tool request, Session id, or raw provider error.

`encodeHostInspectSignaturePayload(request, response)` returns the exact UTF-8 bytes signed with the installation Ed25519 key. The domain-separated statement binds the request id, Desktop client id, challenge, selected version, Host and installation ids, installation public key, generations, process nonce, capabilities, and executable digest.

The public key in an answer is not trust by itself. The Desktop broker must match it to its authenticated installation record and independently compare the peer executable's code-signing digest before accepting the signature. A migration flow may establish that record only through its explicit consent and verification policy; ordinary connection must never silently trust a new key.

`profile.source_authority` accepts an exact server challenge containing the Account/environment, original Source coordinates, full snapshot digest and registered Host epoch. Its dedicated UTF-8 signing domain is `dsh-collaboration-source-authority/v1`, NUL and a fixed-order JSON tuple. The authorized Profile must confirm a durable matching journal entry before signing; membership or registration signatures cannot substitute. The response contains no message, credentials or executable call. The cloud must authenticate and consume its nonce atomically with the snapshot and current Account/Host checks; the signature grants no target execution permission.

`profile.reference_authority` additionally binds `reference_request_digest` to a separate Profile transfer grant. Its signing bytes are `dsh-collaboration-reference-authority/v1`, NUL, and JSON `[1, sourceSigningPayload, referenceRequestDigest]`; the Source signing payload is included as its exact UTF-8 string. Source, workspace and registration signatures cannot authorize reference transfer. The Profile grant reader must independently return the committed Source descriptor and complete reservation digest; the operation exposes neither content nor file paths.

`profile.reference_capture` accepts at most 32 KiB of Source-bound locator, whole/range selection, recipients and user evidence under the current token-verified Account. It normalizes private Profile field ordering and returns at most 32 KiB of computed descriptor/request/digest metadata, without selected bytes. The parent establishes explicit sharing intent before capture and independently validates the full request afterward; capture grants neither content transfer nor task admission.

`profile.reference_content` reads only an original Source, committed reference request digest and byte offset under the current Account. Each response carries a consistent Source descriptor, request/content digests, total length and an exact canonical chunk of at most 32 KiB. The total is at most 1 MiB; zero bytes are valid. Complete content integrity belongs to the client after assembly. Reference bytes do not increase the 64 KiB frame budget or establish sharing or task admission.

`parseHostCollaborationReferenceTarget` validates a private worker lookup containing only original Source coordinates and the complete reference request digest. It cannot supply selected bytes, a snapshot digest or a grant. `parseHostCollaborationReferenceGrant` independently validates the returned committed descriptor and request digest.

## API

`profile.collaboration_delivery` uploads a complete terminal reply through sequential canonical base64url fragments of at most 16 KiB decoded, with a total capsule limit of 1 MiB and an answer limit of 128 KiB UTF-8. Ordinary JSON and 64 KiB frame limits stay unchanged. The final answer-free receipt uses the canonical sorted-key JSON signing domain `dsh-collaboration-delivery-receipt-v1` and binds the verified Account, current installation/process and original Profile commit. Parsing or a signature alone grants no cloud acknowledgement or execution authority.

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

`parseHostRemoteSessionJson` exposes the existing Host JSON limits to private-worker consumers. It detaches parsed data and rejects nonfinite numbers, unsafe keys, excess depth/count and oversized strings; it grants no operation authority.

### Remote workspace directories

The remote directory chooser runs on the Host display. A selected directory receives a Profile-local confirmation bound to the paired client; `workspace.create` consumes it once within 60 seconds and refuses a different path or client. Cancellation returns no confirmation, and picker confirmations are not journaled. The Host advertises `profile.remote_session.directory_picker` only with the worker command executor installed.

## Model Experience

None, as this local Host control codec registers nothing model-facing.

#### KV Cache effect

No direct invalidation; the protocol never contributes model context.

## Known Limitations and Deferred Work

- Remote Session creation accepts optional opaque Workspace and Session IDs; the selected Profile validates the Workspace and idempotently adopts the Session with the native cwd and writer checks. Session identity reuse requires `profile.remote_session.session_reuse`. The wire command has no caller path field.
- **Operation set is bounded** — version 1 decodes `host.inspect`, account and local-only Profile provisioning/restore/open, Profile status/lease-close, migration export begin/read, extension commands, remote Session commands, ten remote UI reads, three native streams (`session/follow`, `workspace/follow`, and `$events`), and common errors. The remote methods remain unavailable until a Host executor advertises them; environment, attachment, and upgrade operations require explicit protocol additions.
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

`profile.collaboration_analysis` carries only an Account-bound prepare/dispatch command and a non-executable preparation or original JSON output. It excludes caller binding digests, limits encoded Source input to 32 KiB and decoded output to 32 KiB, and validates canonical base64url/UTF-8/object JSON without increasing the frame limit. Dispatch output additionally carries an installation signature over its verified Account and current Host identity, original dispatch grant and saved raw JSON digest. The Unix client verifies the signature and unchanged output; the server separately checks current Source, attempt and target authority.

`capture_reply` and `prepare_clarification` additionally carry bounded private input under `profile.collaboration_analysis`. A reply capture returns `reply_source` with only a captured/recovered Source descriptor; complete-input preparation returns `prepared`. Exact command/result keys and action-specific result kinds are checked without changing the frame or JSON budgets. Reply capture grants no model dispatch.
