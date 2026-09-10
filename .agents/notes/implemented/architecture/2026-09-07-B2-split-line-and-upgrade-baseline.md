# Agent Note: B2 separation and upgrade baseline

Status: implemented

English | [中文](2026-09-07-B2-split-line-and-upgrade-baseline.zh.md)

## Problem

REQ-20260907-0016, coordinated with Slark REQ-20260907-0014, separates reusable Host behavior from Slark-specific overlays so an upstream upgrade does not silently change the integration's authority or behavior.

## Decision

Upgrade acceptance uses a fixed upstream SHA rather than a moving reference. Generic capabilities belong in upstream PRs; Slark-specific identity and environment choices remain in the fork overlay. This policy does not establish that an upstream PR is merged or that an upgrade has passed acceptance.

## Capability ownership

| Capability | Owner |
|---|---|
| Event cursors/truncation, session rename/delete/leave, approval v2 settlement idempotency, supportedProtocolVersions negotiation, conformance fixtures | Upstream PRs; complete only after merge |
| Mobile caller profiles, engine/environment claims, capability advertisement, Slark identity/fs/shell adapters, cloud preset switches | Fork overlay: packages/slark*, bundle/slark-cloud, host/slark-identity |
| Slark-specific value domains in Host core/session/interaction sources | host-core-slark-sniff rejection |

## Checks and probes

- [Host-core scanner](../../../../scripts/host-core-slark-sniff.mjs) and its [workflow](../../../../.github/workflows/host-core-gate.yml) check the [controlled value-domain list](../../../../.dsh-slark-value-domain.json). An empty list cannot prove that all Slark-specific values are absent.
- The [drift probe](../../../../.github/workflows/drift-probe.yml) supports weekly and manual runs with optional failure at 50 upstream commits.
- The [replay probe](../../../../.github/workflows/rebase-smoke-report.yml) produces a report artifact. Its presence is not fixed-SHA acceptance evidence; verify the actual selected SHA in each report.

## Alternatives considered

**Keep product-specific values in upstream Host core.** This mixes reusable behavior with Slark authority choices and increases semantic conflicts during upgrades; the separation policy keeps those choices in the overlay.

**Accept a moving upstream reference.** A later reference resolution can select different code, so acceptance requires the exact SHA observed by the run.

## Consequences

The separation preserves a reusable upstream target but leaves semantic adaptation work in the fork. The original 2026-09-07 local investigation recorded fork baseline d85ecaff (0.1.2-alpha.1), target d347e703 (0.1.3-alpha.1), and 1 clean application versus 11 conflicts across 12 isolated attempts. Reported conflicts concentrated in desktop-host, control-protocol, session persistence, core session/agent-loop, CLI, and bilingual documentation. These historical observations are not a rerun or current acceptance result; the complete D1 report remains governed by REQ-20260907-0016 section 4.
