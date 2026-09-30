# Agent Note: B2 capability split and upgrade baseline

Status: implemented

English | [中文](2026-09-07-B2-split-line-and-upgrade-baseline.zh.md)

## Problem

Slark-specific changes in shared host code accumulate upgrade conflicts. A reproducible upgrade drill needs a fixed upstream input and an explicit boundary between generic capabilities and product-specific overlays.

## Decision

REQ-20260907-0016 records the B2 split for qiu-slark REQ-20260907-0014. Generic capabilities go through upstream PRs; product-specific capabilities remain in fork overlays. The recorded drill baseline is fork master `d85ecaff` (`0.1.2-alpha.1`) against upstream `d347e703` (`0.1.3-alpha.1`). CI takes an explicit upstream SHA.

| Capability | Destination |
|---|---|
| events cursors/truncation, session rename/delete/leave, approval v2 idempotent settle, supportedProtocolVersions negotiation, conformance fixtures | Upstream PR; completion requires merge |
| mobile caller profile, engine/environment claims, capability advertisement, slark identity/fs/shell adapter, cloud preset switches | Fork overlay: packages/slark*, bundle/slark-cloud, host/slark-identity |
| Slark-specific value domains in host/core/session/interaction src | host-core-slark-sniff; any match fails |

## Checks and probes

- [host-core-slark-sniff.mjs](../../../../scripts/host-core-slark-sniff.mjs) and [host-core-gate.yml](../../../../.github/workflows/host-core-gate.yml) produce the `host-core-slark-sniff` check; branch protection owns whether that check is required.
- [.dsh-slark-value-domain.json](../../../../.dsh-slark-value-domain.json) owns the controlled value-domain list, whose recorded baseline is empty.
- [drift-probe.yml](../../../../.github/workflows/drift-probe.yml) runs weekly and on dispatch; `total >= 50` can fail when the fail option is enabled.
- [rebase-smoke-report.yml](../../../../.github/workflows/rebase-smoke-report.yml) tries the 12 overlay content commits against the supplied upstream SHA and uploads a report artifact. This report-only probe does not prove a complete upgrade passes.

## Alternatives considered

**Moving upstream ref.** The PRD v2 review freezes a SHA instead of a moving ref so another environment can reproduce the drill input.

**Text-only sniff.** The PRD v2 review selects controlled issuer/scope/clientId value domains instead of product-name text matching to avoid missing runtime branches and flagging documentation.

**Gate disable switch.** The PRD v1 risk discussion raises a disable option; v2 rejects it in favor of documented exceptions with independent approval and an audit record.

## Consequences

Generic capability delivery depends on upstream merge. Product-specific overlays retain their own upgrade work. The checks and report artifact preserve the split and expose conflicts; they do not establish that the full upgrade drill or product baseline switch is complete.

## Verification evidence

The recorded local drill on 2026-09-07 against `d347e703` found 1/12 isolated commits clean and 11/12 conflicting. Conflicts concentrate in host/desktop-host, control-protocol, session-persistence-jsonl, core/session, core/agent-loop, apps/cli, and docs i18n; the main classification is semantic adaptation (class 2). The original record marks REQ-20260907-0016 approved/dev and assigns the full D1 report to its section 4.

The alternatives above are recorded in ai-proj project 212, REQ-20260907-0016, PRD task 21247, document 11981 (v1 risk discussion and v2 frozen input, sniff boundary, and no-disable-switch decisions).
