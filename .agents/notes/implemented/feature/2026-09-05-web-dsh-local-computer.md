# Agent Note: Web DSH uses an explicitly selected local computer for versioned file access

Status: implemented

English | [中文](2026-09-05-web-dsh-local-computer.zh.md)

## Problem

A browser-hosted DSH session runs in a cloud Runtime Cell, but a user's working files remain on a Slark Desktop computer. Treating that computer as an implicit or generic remote executor would make target changes invisible, permit capabilities beyond the first release, and let stale Cell authority outlive a selection or consent change.

## Decision

The independent `WEB_DSH_LOCAL_COMPUTER_V1` rollout switches the enabled Slark cloud provider from its reviewed legacy v1 filesystem/Shell behavior to a file-only Web caller named `web_dsh_v1`; it defaults off and also requires `DSH_SLARK_REMOTE_PROVIDER_V1=1`. Its identity adapter accepts only the exact v2 runtime-authority document, verifies assignment generation and selection publication against `.publication-state`, and passes the complete consent, protected-root, broker, and authority fences to the Device client. The Device client requires the request and authority caller profiles to match and rejects Shell, process, and artifact operations before transport.

`fs-slark-remote` emits only `dsh-fs-request-v2` for this profile, accepts only matching v2 results, rejects non-NFC paths, and requires prior-observation guards for writes and edits. Legacy profiles retain v1 parsing and mutation semantics; v1 cannot satisfy a Web request.

The browser contributes `ui-slark-local-computer` to `sidebar.footer.action`. It displays non-sensitive computer and workspace labels and performs one explicit publication-version CAS request after user confirmation. A conflict refreshes state and requires another confirmation. The connection service confines calls to same-origin `/api/slark/` paths and mirrors the host-only CSRF cookie on unsafe methods. Concurrent mount, focus, modal, and polling refreshes carry a page-local monotonic sequence so a stale response cannot overwrite a newer selection. The Edge response alone decides whether the page reloads so Runtime Cell replacement and browser state converge.

When the new rollout is enabled, the Slark cloud preset contains file tools but no Shell, jobs, persistent terminal, `glob`, `grep`, or Shell-backed permission preset controls. When it is off, the existing v1 Shell/jobs and permission surface and matching persona remain unchanged. The composition gate proves both branches and rejects a flag expression that could mix their authority surfaces or leave a Shell-dependent service active without Shell.

## Alternatives considered

**Keep remote Shell for search.** Rejected because Shell is a much broader execution authority than the first release needs, and search convenience does not justify bypassing the safe-file broker boundary.

**Automatically select the only available computer.** Rejected because selection changes authority and may restart the Runtime Cell; the user must see and confirm the target even when only one option exists.

**Retry selection conflicts in the browser.** Rejected because a retry could overwrite a newer choice from another tab or device. Refresh-and-confirm preserves the user's CAS intent.

**Accept v1 authority and infer missing Web fences.** Rejected because inferred policy or publication versions would turn an incomplete authority into a valid one. Profile matching is exact and fail-closed.

## Consequences

The Web product has a visible, explicit local-computer target and cannot use that target for command execution. Target, consent, policy, broker, assignment, or publication drift fails before or at the authoritative Device boundary. The Edge Browser DTO is parsed as an exact, bounded shape, including `computer_display_code`; target-list publication version may begin at zero while issued authority publication fences remain positive. Existing non-Web integrations remain compatible with v1. The trade-offs are no remote file search in the first release, a page reload when Edge replaces the Cell, and page-local polling until a safe push channel exists.
