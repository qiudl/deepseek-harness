---
description: "Strict canonical wire frames for Desktop-to-DSH-Host identity negotiation and control errors."
kind: "package-reference"
---

# dsh-host-control-protocol

English | [中文](README.zh.md)

## Summary

This zero-I/O library owns the local control wire shared by the Desktop broker and the single DSH Host supervisor. Version 1 starts with a signed `host.inspect` challenge exchange and includes Profile lease and migration-export payloads. Later operations must retain this package's canonical JSON-Lines envelope, branded identities, bounded frame, and sanitized error vocabulary.

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

## Model Experience

None, as this local Host control codec registers nothing model-facing.

#### KV Cache effect

No direct invalidation; the protocol never contributes model context.

## Known Limitations and Deferred Work

- **Operation set is bounded** — version 1 decodes `host.inspect`, Profile open/status/lease-close, migration export begin/read, and common errors. Environment, session, approval, and upgrade operations require explicit protocol additions.
- **Transport enforcement is external** — the Unix-domain-socket carrier must stop reading at the byte cap and close on the first codec failure.
- **Cryptographic policy is external** — key persistence, code-signature inspection, challenge signing and verification, replay storage, and key rotation belong to the Host identity and Desktop broker packages.
