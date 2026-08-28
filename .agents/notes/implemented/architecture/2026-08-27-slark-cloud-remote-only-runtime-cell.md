# Agent Note: Slark cloud Runtime Cells are remote-only execution planes

Status: implemented

English | [中文](2026-08-27-slark-cloud-remote-only-runtime-cell.zh.md)

## Problem

Slark exposes DeepSeek Harness as a personal workbench inside its cloud Web surface while the files and Shell that matter remain on the user's selected Desktop device. A normal DSH Web profile intentionally owns local filesystem, subprocess, sandbox, and Shell providers. Reusing that profile unchanged creates a dangerous ambiguity: a missing device connection can silently turn an operation into execution inside the cloud Runtime Cell, which is neither the user's computer nor the granted workspace.

Identity has the same boundary problem. The cloud process needs a short-lived Slark subject and the exact Device, Workspace Grant, generation, and epoch fences for every remote operation, but those facts must not enter model prompts, session logs, browser storage, or a process-wide mutable singleton that can cross sessions.

The Agent preset is also part of the execution contract. Showing a cloud-only preset in standalone DSH makes its Desktop-mediated label false because that deployment correctly retains local providers. Hiding only UI controls does not prevent an API, stored setting, or alternate entry point from selecting the wrong composition.

## Decision

The `slark-cloud` bundle is a host-plane provider substitution applied after the base and Web layers. It hard-disables every cell-local execution provider and mounts the Device client, identity adapter, remote filesystem, and remote Shell behind one exact feature switch. Turning the switch off disables all four remote rows together and restores nothing, so an unavailable rollout fails closed.

The Slark Edge publishes a private assignment state plus one short-lived authority file per DSH Session through a separate, loopback-only Writer identity for each Cell. `dsh-slark-identity` opens and validates the session-specific file for every provider operation, refreshes missing or near-expiry authority through a body-bound HMAC request, checks the workspace handle fixed into the DSH child, and binds the resulting authority through `AsyncLocalStorage`. Concurrent refreshes for one session share a request, and neither refresh responses nor model-visible state contain the subject token.

The assignment state carries generation and publication-version fences with the selected Workspace Grant. The identity adapter registers that workspace's read-only projection under its Slark alias. A supervisor replaces the DSH child when the published assignment revision changes; the Edge waits for the replacement before completing bootstrap. Each Writer has a distinct OS identity and per-Cell control key, while the DSH process receives only read access to its own authority and projection directories.

The default served-Web HTTP carriers implement the Edge's double-submit CSRF check. Before every POST they read the `__Host-dsh_csrf` cookie and overwrite `x-slark-dsh-csrf` with that value. Missing cookies produce no header and fail closed at the Edge; custom transports own their authentication, and WebSocket downlinks carry no CSRF token.

The cloud Agent preset contains only provider-neutral agent capabilities and tools backed by the remote filesystem or Shell seams. Subprocess-backed search, persistent terminals, LSP, hooks, directory picking, and Cordis or plugin authoring are absent. The profile disables user preset discovery and preset switching.

The CLI carries the cloud preset in a separate shipped root. It selects that root only when the composed profile contains the Slark Device provider row, including while the shared switch disables that row. Standalone profiles continue to discover only the ordinary shipped root, so they retain their local providers without exposing a misleading cloud preset.

The Slark cloud client build sets `DSH_CLIENT_SLARK_WORKBENCH=1`. The deployment-brand browser plugin then occupies `sidebar.footer.action` with one visible Enterprise workbench link. Its exact `slark-workbench://switch/slark` top-level navigation is accepted by Slark Desktop's isolated DSH view and rejected outside that allowlist; standalone browser builds do not render the action.

One DSH child fixes one workspace handle. Selecting another Workspace Grant atomically advances the assignment state and replaces that child instead of mutating a live provider boundary.

## Alternatives considered

**Let the browser call a Desktop localhost server.** Rejected because browser security policy, origin trust, port discovery, and corporate proxies make localhost reachability unreliable, while a Desktop-authenticated outbound channel gives Slark one mediated route on macOS and Windows.

**Keep local providers as a fallback when the Device is offline.** Rejected because a successful command in the wrong execution world is worse than an explicit unavailable result. Local providers remain correct in standalone DSH and are deliberately absent only from the Slark cloud deployment.

**Pass one subject token through environment variables or cache it at process scope.** Rejected because rotation, concurrent sessions, and reassignment can make a cached authority stale or cross a tenant boundary. Per-session files preserve concurrent identities without putting tokens in command arguments, and per-operation validation keeps revocation and generation fences current.

**Let the Edge write into Cell directories as the Cell user.** Rejected because a compromised Cell could then impersonate the publisher or alter another session's authority. A distinct Writer user owns publication, and the Cell group receives read-only access.

**Hide local tools and preset controls only in the Web UI.** Rejected because model tools, API calls, stored settings, and non-browser entry points still address the host composition. The provider rows and discovery roots, not presentation, enforce the boundary.

**Rely on the Desktop keyboard shortcut for the return trip.** Rejected because a hidden escape path does not make two visible workbenches feel like one product. The shortcut remains a recovery path, while the sidebar action is the discoverable route.

**Let the Edge trust the session cookie alone or copy it into a header.** Rejected because either form collapses double-submit CSRF into ordinary cookie authentication, allowing a cross-site POST to satisfy the same check. The browser must prove script access to the host-only CSRF cookie through a separate request header.

## Consequences

A Slark cloud session either reaches the selected Device under its current Workspace Grant or fails explicitly; it never executes against the Runtime Cell filesystem or Shell. Disabling the rollout switch is safe but intentionally removes file and Shell capability from new agent compositions.

Authority publication, Writer health, Device connectivity, Grant lifecycle, supervisor reload, and Edge CSRF cookie issuance become required deployment health signals. Workspace switching restarts the DSH child and briefly holds bootstrap until it is ready. Remote search has no dedicated provider yet, so agents use bounded remote Shell commands when search is necessary.

Revocation freezes a Runtime Cell and advances its generation; allocation selects only `ready` Cells. A frozen Cell is never reassigned with its existing home. Any future Cell-recycling mechanism must erase tenant state before it can restore `ready` status.

Standalone DSH behavior does not change: its existing presets and local providers remain available, the Slark cloud preset is not discoverable there, and its sidebar has no Slark return action.
