# Agent Note: B2 upstream separation and upgrade baseline

Status: implemented

English | [中文](2026-09-07-B2-split-line-and-upgrade-baseline.zh.md)

## Problem

REQ-20260907-0016, coordinated with qiu-slark REQ-20260907-0014, separates shared Harness protocol work from Slark-specific overlays so upstream upgrade conflicts can be measured independently. The original requirement record was approved/in development; this note records the separation policy and checked-in probes, not completion of that requirement.

## Decision

The separation policy assigns changes as follows:

| Capability | Destination |
|---|---|
| Event cursors/truncation, session rename/delete/leave, idempotent approval v2 settlement, supportedProtocolVersions negotiation, conformance fixtures | Upstream PR; completion requires upstream merge |
| Mobile caller profile, engine/environment claims, capability advertisement, Slark identity/fs/shell adapters, cloud preset switches | Fork overlay: packages/slark*, bundle/slark-cloud, host/slark-identity |
| Slark-specific value domains in Host/core/session/interaction source | Rejected by the required host-core-slark-sniff policy |

The original baseline record names fork master `d85ecaff` (0.1.2-alpha.1) and upstream 0.1.3-alpha.1 head around `d347e703`. Its CI policy requires an input SHA rather than a moving ref. These are historical references, not the current runtime pin.

## Probes

The [Host/core workflow](../../../../.github/workflows/host-core-gate.yml) runs [host-core-slark-sniff](../../../../scripts/host-core-slark-sniff.mjs) using [.dsh-slark-value-domain.json](../../../../.dsh-slark-value-domain.json), whose checked-in list is empty. The [drift probe](../../../../.github/workflows/drift-probe.yml) runs weekly or manually and optionally fails at 50 upstream commits. The [replay report](../../../../.github/workflows/rebase-smoke-report.yml) uploads a report-only artifact. Its current script can fall back to upstream/master; its existence alone does not prove the historical fixed-input-SHA policy is enforced.

## Alternatives considered

**Slark-specific values in shared core:** the recorded policy rejects this placement through the sniff gate and assigns those values to fork overlays.

**Moving references for baseline comparison:** the recorded baseline policy rejects these in favor of an explicit input SHA. The replay workflow fallback remains a limitation rather than evidence of compliance.

## Consequences

The recorded local study on 2026-09-07 independently replayed 12 content commits onto `d347e703`: one applied cleanly and 11 conflicted. Conflicts concentrated in host/desktop-host, control-protocol, session-persistence-jsonl, core/session, core/agent-loop, apps/cli and documentation i18n. The record classifies the dominant work as semantic adaptation (class 2); the full D1 report remains governed by REQ-20260907-0016 section 4. These results do not establish today's mergeability or test status.
