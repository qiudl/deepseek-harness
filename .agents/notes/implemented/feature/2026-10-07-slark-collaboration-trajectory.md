# Agent Note: Original Session collaboration trajectory

Status: implemented

English | [中文](2026-10-07-slark-collaboration-trajectory.zh.md)

## Problem

REQ-20261004-0008 requires one original DSH Trace ID to connect remote execution with feedback. Local Session events alone cannot establish remote settlement, delivery or consumption. A Session containing only separately persisted collaboration Sources also remains blank to the ordinary Conversation shell, hiding its view tabs.

## Decision

Trajectory owns a Session slot for external histories. Slark contributes an authorized readonly projection through Desktop Main, using the original Source to recover its root. Cloud audit order and runtime observation order remain separate; both are paged. Root state, execution state, delivery and consumption are distinct observations, and missing coverage stays explicit.

A Conversation binding can retain shell activity for external records through independently released contributions. Slark retains this activity while its current Source history is nonempty. The contribution affects presentation only: no fabricated Session event, ordinary model request or execution grant makes an empty conversation appear active.

An expiring Main preview is a temporary selection handle, not an execution or consumption record. Refreshing that handle preserves the original task's observed outcomes. Consumption recovery refreshes it only after Main explicitly reports rejection before entering the consumer; uncertain transport failures provide no retry authority. The original Source, Trace ID, frozen tasks and requested action must remain unchanged. See the [result model](../../../../packages/client/ui-slark-agent/README.md) for its bounded recovery behavior.

## Alternatives considered

**Copy cloud audits into Session events.** This would add durable model-history obligations to a readonly view and duplicate independently authorized records.

**Require an ordinary chat turn first.** This hides the trace of a valid first collaboration request, so the original-message trajectory would not be an available acceptance path.

**Give Slark its own conversation page.** A second navigation path would separate the initiating conversation from its execution feedback; the owned Trajectory slot preserves that context.

## Consequences

Every cloud read revalidates authority; account, workspace and connection changes discard cached records. Provider internals remain unobservable and audit coverage stays partial. Activity releases are independent and idempotent, and Session disposal removes them. Verification includes an empty-Session shell, plugin disposal, bounded paging, late-response rejection and the assembled Trajectory entry; external fixtures do not certify installed-provider acceptance.
