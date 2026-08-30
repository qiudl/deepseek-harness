# Agent Note: Slark plugin catalog and market

English | [中文](2026-08-30-slark-plugin-catalog-market.zh.md)

Status: proposed

## Problem

DeepSeek Harness can install profile bundles, but users must already know a package or repository identifier. The community directory is external YAML controlled by many contributors; loading it directly into a model or browser would mix unvalidated data with product evidence and make failed refreshes indistinguishable from current results.

## Proposal

The Slark cloud bundle mounts a read-only plugin directory consumer. A catalog package validates one complete upstream Git revision into immutable, deterministically sorted entries and publishes it atomically. Natural-language discovery produces only a bounded query intent, and every returned identifier and displayed fact comes from one catalog revision.

The catalog is a Host capability seam (`ctx.pluginCatalog`). The model-facing consumer registers one read-only `plugin_search` tool, rejects undeclared intent fields, and resolves the accepted intent against the service's current snapshot. The model never returns catalog entries or source locators directly.

Catalog membership remains distinct from source verification and security review. The read-only milestone exposes no profile mutation operation. Installation is a later capability with a separate trusted confirmation and execution process.

## Alternatives considered

**Install the existing dsh-market bundle unchanged.** It does not own Slark identity, immutable revision evidence, stale-state reporting, or the trusted installation protocol, so it cannot establish the required product guarantees.

**Let the model search GitHub directly.** GitHub topics do not prove `dsh.bundle` compatibility, and model-generated package identifiers can name entries absent from the reviewed directory.

**Parse entries in the browser.** This duplicates validation across clients and lets one malformed or oversized refresh consume renderer resources. The Host owns validation and publishes one bounded snapshot.

## Acceptance criteria

- A malformed, oversized, duplicate, or identity-mismatched source file rejects the complete refresh and preserves the previous successful snapshot.
- Entry identity and revision remain stable across source-file ordering.
- Search results are a subset of one explicit revision and use a deterministic secondary order.
- The read-only milestone has no profile write or plugin-management command path.

## Risks

Directory users may interpret validation as endorsement. UI copy must identify entries as directory candidates and reserve source verification or security-review labels for evidence produced by those separate processes.
