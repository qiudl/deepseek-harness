# Agent Note: Preserve path budget for Windows private-file replacement

Status: implemented

English | [中文](2026-09-15-windows-private-replacement-path-budget.zh.md)

## Problem

The private-file adapter appended a hyphenated UUID and `.tmp` to the complete destination path. An MSIX package-local DSH account-keyring path can be 219 characters, making the temporary path exactly 260 characters and causing the native create or move operation to fail at the legacy Win32 path boundary after all shorter identity files succeed.

## Decision

Atomic replacement keeps the UUID's full 128 bits of randomness but removes its four presentation hyphens before forming the temporary sibling name. The suffix is reduced from 41 to 37 characters without reducing collision resistance or changing the create-new, flush, stable-handle verification, move-replace, and cleanup sequence.

## Alternatives considered

**Shorten the durable account-keyring filename.** Rejected because it changes an established storage contract and does not protect other replacement callers near the same boundary.

**Disable atomic replacement for packaged applications.** Rejected because a crash could leave a partially written authority file.

## Consequences

The observed MSIX path remains below the legacy boundary while preserving the existing security and durability protocol. Paths that are intrinsically too long still fail closed in the native operation.
