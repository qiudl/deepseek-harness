# Agent Note: Export Windows storage adapters from the sealed startup artifact

Status: implemented

English | [中文](2026-09-15-windows-sealed-startup-storage-exports.zh.md)

## Problem

The Windows desktop embedding verifies and imports the release-sealed `windows-startup.js` artifact before preparing its local Profile vault and legacy-source probe. Those two adapters were implemented and exported from the general `startup.js` artifact, but not from the sealed Windows artifact. Packaged startup therefore reached host identity creation and then failed closed because the expected storage export was absent.

## Decision

Re-export `loadWindowsLocalProfileStorage` and `loadWindowsLegacySourceProbe` from the Windows startup entry. Keep the embedding on the same release-pinned, hash-verified artifact instead of introducing a second trusted script. Extend the built-artifact test to assert both exports after importing the standalone Windows bundle from memory.

## Alternatives considered

**Point the embedding at the general startup artifact.** Rejected because it expands the sealed Windows startup surface and changes the artifact contract used by the Host composition.

**Load the storage implementation through an unverified package path.** Rejected because local Profile ciphertext access must remain bound to release-pinned code and the held native-module lease.

## Consequences

The Windows embedding and legacy probe can load their adapters from the artifact whose bytes they already verify. The adapter implementations and their fail-closed native authority checks are unchanged.
