# Agent Note: Slark workspace project scope

Status: implemented

English | [中文](2026-10-03-slark-workspace-project-scope.zh.md)

## Problem

REQ-20260930-0004, project212, T21 /22661. The optional collaboration area edits a Slark project restriction for the Session's actual DSH workspace; it is separate from task submission. A workspace starts with no projects, and an ungrouped Session inherits no workspace.

## Decision

Scope mode closes the legacy assignment directory and invocation path. The new project restriction does not authorize those old endpoints. Main's scope and execution switches default off. Scoped Agent candidates become selectable only when Main enables v2 submission and the server qualifies independent execution; other directory entries remain read-only. Ordinary chat and existing task history remain available.

Scope data belongs to a React-free Session projection observed through the slot's hooks compartment. Workspace membership comes from Workspace Controller, and the panel's unsaved selection stays component-private. Account and Native authority remain in Desktop Main. A delayed read cannot restore a preceding workspace or bridge identity. Saves use the current authority version; every save attempt reloads scope without automatic replay.

## Consequences

An explicit scoped chip sends the complete original message and UTF-16 occurrence to Main without a task form or confirmation preview. Pick-time workspace, Session, target, capability digest and UUID bind its Source. Unknown submissions retain their draft and identity; editing text does not mint a replacement Source. A new explicit pick creates a new request. Main owns original Source capture, analysis, freezing and admission; the Client receives only original coordinates and accepted status. Acceptance is not execution completion, and the original-Session v2 readonly result area is connected; durable Host replies and signed acknowledgments remain pending.

The v2 result area enumerates committed original messages through Native paging, then reads each Source's authorized results through Main. Membership or Connection generation changes clear view data; refresh retains loaded history pages. Restricted responses remove answers and target names, while older delivery versions cannot roll known state backward. Reads neither sign acknowledgments nor create ordinary chat turns.

## Alternatives considered

Filtering the old assignment list while retaining legacy invocation would let cached chips or another renderer call bypass the new project restriction. The scope mode therefore uses its own current-authority directory and submission path.

## Testing

Verification covers model lifecycle and continuation, the component's multi-select/apply/cancel, and the built AppWebEntry composition with a Desktop transport fixture. Native signing, Main HTTP coordination, and restricted PostgreSQL are exercised in Slark's owner-local integration suite. The Profile-worker membership reader, daemon inspection, Slark authentication and Electron IPC are external fixtures in that combination; it does not establish packaged-runtime or production acceptance.

The YAML-loaded source and real SessionInputShell cover scoped candidate selection, complete Source submission, deliberate retries with the same identity, changed workspace/archive/bridge, transport loss and late or substituted acceptance. Desktop transport is a fixture in those Client tests; the actual provider, tools and GUI loop still requires acceptance.

The real YAML registrant, SessionInputShell admission event and results model are exercised together. React DOM tests retain complete 128 KiB plain text replies. Native cold Profile tests read original journal bytes and cover paging and membership rejection. Server/provider peers remain fixtures; these checks do not certify an actual model or installed GUI loop.
