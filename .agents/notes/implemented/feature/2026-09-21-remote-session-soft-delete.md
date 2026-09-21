# Agent Note: Remote Session soft delete

Status: implemented

English | [中文](2026-09-21-remote-session-soft-delete.zh.md)

## Problem

Slark mobile and Web clients need a `session.delete` operation, but Session logs are append-only records and the Host has no physical deletion primitive. Treating the mobile verb as log deletion would contradict persistence guarantees, while acknowledging before live work settles would leave hidden work running.

## Decision

The Session Controller exposes `session.delete` as a user-visible soft delete. It first adds the known Session to the Workspace registry's durable global archive set, preserving its log and Workspace accounting. For an attached Agent, it then cancels active work without retaining the inbox and waits for the whole Agent activity to become idle before returning `{ deleted: true }`. A definite unknown Session becomes `session/not-found`; storage failures propagate unchanged.

`session.leave` remains absent because the local Host has no collaboration membership to revoke. Remote file bytes remain on the authenticated streaming upload route; the control Remote does not add a chunked attachment verb.

## Alternatives considered

**Physically delete the Session log.** Session persistence intentionally has no deletion operation, and committed generations remain immutable.

**Reuse `workspace.archiveSession` only at the Slark adapter.** That would make the public mobile operation depend on a second Remote namespace and would not cancel or drain live Agent work.

**Transfer attachment bytes through `session.attach`.** The existing upload service already streams bytes outside Typert Remote and binds a Host-minted receipt to the exact Session and Agent. Duplicating that path would increase relay memory pressure and weaken scope ownership.

## Consequences

Deleted Sessions disappear from Session lists, search, and grouping surfaces but remain available to persistence, audit, and Workspace accounting. The acknowledgement can wait for provider cancellation to converge. The operation is idempotent through the archive set. Shared-session leave needs a future membership owner, and remote browsers need a separate authenticated or end-to-end encrypted byte transport before they can reuse Host upload receipts.
