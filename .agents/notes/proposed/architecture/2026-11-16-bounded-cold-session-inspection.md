# Agent Note: Bounded cold Session inspection

Status: proposed

English | [中文](2026-11-16-bounded-cold-session-inspection.zh.md)

## Problem

`SessionPersistence.stat().sizeBytes` measures compressed physical storage, while a normal cold read loads and decodes the entire Session. A small zstd artifact can therefore require far more memory than a caller's physical-size preflight permits. A source can also change between preflight and an unbounded read. Consumers that need a trustworthy complete old Session cannot enforce their own memory budget through `open('read')` or a paged query.

## Proposal

The persistence seam offers optional `inspectBounded` for a complete current-format log with physical-byte, decoded-byte, and event limits, cancellation, and an optional expected revision. The JSONL provider reads through one file handle, caps each zstd frame's output, validates the whole log, and checks source identity before returning. The query seam offers `readColdSessionBounded` to replay-validate that log and balance an interrupted final turn in memory. Exceeded limits, historical generations, incomplete records, and changed sources reject without a partial result. Providers without this capability reject explicitly.

## Alternatives considered

Relying on `stat().sizeBytes` alone leaves decompression unbounded. Paging through the existing query still requires a complete cold load before pagination. Teaching a consumer to read JSONL directly would duplicate storage-format and migration rules outside the provider.

## Acceptance criteria

Tests cover raw and zstd logs, highly compressible input, each budget, stale revision, historical generation, cancellation, and replay validation. The generated public API and paired subsystem documentation describe the capability. A consumer can call the query seam without opening storage paths.

## Risks

The limits bound input bytes and event count, while the in-memory object graph and detached result can occupy more bytes than the decoded stream. Callers should choose budgets for their available process memory. This API rejects historical generations rather than migrating them under an unproven budget.
