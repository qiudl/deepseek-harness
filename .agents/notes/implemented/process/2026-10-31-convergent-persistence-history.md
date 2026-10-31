# Agent Note: Convergent persistence history

Status: implemented

English | [中文](2026-10-31-convergent-persistence-history.zh.md)

## Problem

Independent accepted changes can start from the same Session schema and both reach an integration. Replacing either acknowledgement would erase a committed transition, while a single-predecessor history cannot retain both branches and identify one current schema.

## Decision

The [in-tree persistence history decision](2026-09-11-persistence-type-history.md) retains ownership of schema extraction, per-root acknowledgements, and finalized checkpoint protection. This decision supersedes its single-successor restriction only for explicitly converged histories.

A version 2 acknowledgement may name distinct predecessor branches with a common ancestor for a root. Its after schema is compared with every parent; each transition must contain a change, remain same-version, and require no additional classifier compatibility review. All branches must reach one terminal record. Missing parents, redundant ancestors, unresolved tips, cycles, and checkpoint records that omit a parent fail verification. Existing version 1 declarations and finalized record digests stay unchanged.

## Alternatives considered

**Rewrite one accepted branch.** This creates a linear chain but changes an already committed acknowledgement and its historical comparison.

**Accept unresolved branches.** Multiple terminal schemas cannot identify the current root or establish how either branch reaches it.

**Allow arbitrary breaking merges.** A multi-parent acknowledgement would conceal which predecessor requires a compatibility decision; restrictive same-version merging keeps such changes on separately reviewed transitions.

## Consequences

Authors retain both parent snapshots and record the merged after schema once. The checker evaluates every parent transition but cannot establish reader behavior from types alone; the acknowledgement still records compatibility evidence. Version-bump merges require separately ordered transitions. The [history reference](../../../../docs/persistence-changes/README.md#history-and-limitations) defines the accepted declaration.
