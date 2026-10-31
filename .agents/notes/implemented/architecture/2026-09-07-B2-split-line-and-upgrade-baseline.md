# Agent Note: B2 split line and upgrade baseline

Status: implemented

English | [中文](2026-09-07-B2-split-line-and-upgrade-baseline.zh.md)

## Problem

The Slark fork needs DSH protocol improvements without placing Slark-specific values in upstream Host, core, Session, or interaction source. Rebase conflicts make the boundary easy to erode.

## Decision

Reusable event cursors and truncation, Session rename/delete/leave, idempotent approval v2 settlement, protocol-version negotiation, and conformance fixtures belong upstream. Mobile caller profiles, engine and environment claims, capability advertisements, Slark identity/fs/shell adapters, and the cloud preset remain fork overlays.

The required `host-core-slark-sniff` check rejects Slark-specific values in Host, core, Session, and interaction source. `.dsh-slark-value-domain.json` is the controlled value inventory. `drift-probe.yml` reports upstream drift, while `rebase-smoke-report.yml` tries overlay commits against a pinned upstream SHA and uploads a report.

## Alternatives considered

**Slark-specific values in shared Host/core:** The split-line table assigns these values to fork overlays, and the required sniff check rejects their appearance in shared source.

## Consequences

The fork keeps product-specific identity and capabilities outside shared packages, while common protocol behavior can be reused upstream. Upgrades still require semantic conflict review: the recorded twelve-commit probe against pinned upstream `d347e703` applied one commit cleanly and found conflicts in eleven, especially around Host, control protocol, Session persistence, agent loop, CLI, and documentation.
