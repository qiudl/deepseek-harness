# Agent Note: Person Profile ownership of legacy model credentials

Status: proposed

English | [中文](2026-09-18-person-profile-model-ownership.zh.md)

## Problem

The fixed OS-user `.dsh` home predates authenticated Person Profiles. Its credentials and model settings have no account owner. Importing them into the first active Profile silently assigns that account control of every provider. Per-Profile worker directories and empty launch environments isolate newly entered credentials but do not correct this legacy import.

## Proposal

The fixed legacy exporter transfers sessions, workspace and only the reviewed account-neutral settings namespaces (`agent-loop`, `permission`, `shell`, `ui-onboarding`). It withholds all credentials and every other settings namespace, including default model, search-provider keys, and unknown future plugins. It reads and validates the original documents, leaves them unchanged, and carries a digest of the withheld data so inventory confirmation detects a concurrent source change. This closes implicit assignment for new imports without changing ordinary Profile-to-Profile migration.

DSH Models settings will present a redacted, provider-specific claim action for an authenticated Person Profile. The claim will check source ownership and generation, commit the provider credential and corresponding route into that Profile, and record single-owner consumption before the route becomes usable. A failed or interrupted claim retains the original files and a retryable status. The same account may retry idempotently; a competing account receives a conflict. Existing Profile generations containing automatically imported legacy values require a separate upgrade migration before model reuse can be enabled in Desktop.

## Alternatives considered

**Import all legacy credentials with the workspace.** This preserves the previous behavior but gives the first login implicit control of credentials that have no account owner.

**Discard the legacy files after transfer.** This prevents future claims and risks permanent credential loss on interrupted migration. The original files remain available as the claim source.

## Acceptance criteria

- A fresh legacy transfer leaves every provider credential and model route unavailable to both accounts until an explicit claim, while workspace, sessions and reviewed account-neutral settings survive.
- Claiming one provider exposes only that provider to the confirmed account; a second account cannot claim or read it. Repeated and interrupted claims have deterministic recovery without plaintext disclosure.
- Existing automatically imported Profile generations are made safe before Desktop enables personal model reuse.
- macOS and Windows installed artifacts enforce the same account and source ownership rules.

## Risks

Withholding model data makes migrated Profiles temporarily unable to call a legacy model. Existing Profile generations may already contain imported credentials. The claim UI and upgrade migration must ship before this proposal can be treated as complete.
