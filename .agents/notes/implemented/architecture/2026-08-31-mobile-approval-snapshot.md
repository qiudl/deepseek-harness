# Agent Note: Bind mobile approval to the displayed operation snapshot

Status: implemented

English | [中文](2026-08-31-mobile-approval-snapshot.zh.md)

## Problem

Slark iOS can safely allow a DSH operation only when the host supplies complete structured context. The legacy approval frame named a tool and optional reason but did not bind the user's decision to the working directory and rendered action.

## Decision

The Host derives a bounded v2 snapshot from the immutable `tool/call` event and its registered presenter. It includes working directory, action, impact, a five-minute expiry, and a process-secret HMAC digest. Mobile allow must echo the digest before expiry; reject remains available without it. Calls without a call id, presenter, cwd, or complete bounded projection remain legacy reject-only frames.

The authenticated Slark local descriptor advertises `slark_mobile_approval_v2`. Slark probes the current registration, so daemon connectivity alone never implies approval support.

## Consequences

Reconnect replay preserves the original pending snapshot and digest. A host restart invalidates all pending requests and its process secret. The snapshot contains presentation data only and never exports raw tool arguments.

## Alternatives considered

- Sending raw arguments was rejected because presenters are the existing redaction and display boundary.
- Trusting only rpc/session ids was rejected because it did not cryptographically bind the displayed operation.
- Making incomplete approvals disappear was rejected because users must retain a safe reject path.
