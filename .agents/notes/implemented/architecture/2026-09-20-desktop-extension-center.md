# Agent Note: Desktop Extension Center belongs to DSH navigation

Status: implemented

English | [中文](2026-09-20-desktop-extension-center.zh.md)

## Problem

An extension manager launched as a separate Slark surface cannot inherit the active DSH Profile lifecycle. It can therefore ask for Host extension authority while no verified Profile view exists, producing `dsh_profile_view_required` and a navigation experience that looks unrelated to DSH.

## Decision

The Extension Center is a DSH client plugin. It contributes a footer action immediately above Settings and a root-scoped `main` panel with Plugins, MCP, and Skills tabs. The Slark menu and shortcut route to that same panel rather than opening a second window.

The client contribution is capability-gated. A dedicated, isolated Desktop bridge must complete a versioned `hello()` for the active Profile before either slot registration exists. The bridge exposes explicit extension methods and structured result codes; it does not expose Electron IPC, profile selectors, credentials, filesystem paths, or a generic command channel. Missing or rejected authority fails closed.

Selecting the panel keeps the Conversation mounted but hidden. Tab preference is scoped by an opaque Profile key. Host inventory and later mutation transactions remain outside React; the DSH page owns presentation state and ignores stale asynchronous completions.

Plugin preparation performs a zero-write read of the immutable npm version or GitHub commit manifest. Recognized lifecycle scripts and exact commands are bound to the plan with a digest. Scripts stay disabled unless Desktop returns that digest in a second confirmation; Host then adds only the reviewed exact `package@version` to the Profile build policy. Removal, repair, and unapproved installs continue to disable scripts.

The renderer retains only the last opaque operation UUID per Profile and reconnects it to Host status after reload. Main also monitors a committed operation independently of the renderer and reopens the active local, offline Account, or online Account Profile only after Host reports success. Unknown outcomes remain visible and are never automatically replayed. The update flow accepts an exact older source as an explicit version restore.

## Alternatives considered

**A standalone Slark Hub.** It separates the entry from DSH navigation and cannot naturally inherit DSH Profile readiness.

**Always-visible DSH navigation with an unavailable page.** This advertises a capability before its authority exists and repeats the original failure at a later click.

**A general preload bridge.** It makes future methods easy to add but destroys the reviewable authority boundary.

## Consequences

Browser-hosted DSH deployments have no Extension Center entry. Desktop builds need matching bridge protocol support before the package becomes visible. Menu routing, inventory, and mutations all converge on one Profile-bound surface, while DSH slot disposal and preload listener removal provide one reversible lifetime.
