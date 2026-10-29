# Agent Note: Profile-scoped Session memory reads

Status: proposed

English | [中文](2026-10-29-profile-scoped-session-memory.zh.md)

## Problem

A separate memory agent cannot inherit a DSH user's Session authority. A Session ID identifies a log but does not authorize its contents. Copying an entire account history into the agent would also expose tool payloads and credentials and consume more context than a targeted answer needs.

## Proposal

Keep Session ownership in the authenticated Desktop Host and its selected Person Profile. A Profile-local reader should enumerate only that Profile's persisted Session snapshots and return bounded, redacted user and assistant text for indexing. The Host should verify the current owner, Profile, installation, and process generation before and after each read. A signed, short-lived directive should authorize each search or evidence request; a worker should receive projected pages and return candidate references, never raw Session logs.

The current master stores Session format v0. Its persisted top-level header has `type: "session"` and no seed or parent fields. The projection therefore rejects a header with seed, parent, origin, or nonzero delegation depth and rejects replaced source events. It accepts only the current v0 append representation. The private reader still needs an implementation against the current `SessionPersistence` API; the internal Host modules alone do not enable product reads.

## Alternatives considered

**Give the memory agent access to the DSH home.** File access would bypass the selected Profile and expose raw logs, tool results, and unrelated credentials. A Session ID would become an accidental capability.

**Send all Session text through the Slark server.** This would expand the trust and retention scope and require large prompt context. The first version keeps retrieval and the model on the enrolled Mac.

**Read JSONL paths directly from the worker.** The worker would gain raw filesystem access and would have to reproduce the persistence layer's live and recovery semantics. The Profile-owned reader should use supported persistence operations instead.

## Acceptance criteria

- An authenticated Profile can retrieve a bounded, redacted excerpt from one of its own current v0 Sessions using a signed directive.
- Switching Profile, owner, or Host generation invalidates an in-flight read and its cached index.
- Another Profile, an expired or replayed directive, and a forged worker candidate reference reveal no excerpt.
- The memory worker cannot read raw Session files, and a production flag remains off until these checks pass on a synthetic account.

## Risks

The current `SessionPersistence.inspect()` returns a logical snapshot rather than a raw JSONL artifact, while the initial projection accepts JSONL text. The product reader must use one authoritative representation and retain revision checks; copying a historical route from another branch would create a format mismatch. Redaction can miss unknown credential forms, so bounded output and explicit user consent remain necessary before importing real history.
