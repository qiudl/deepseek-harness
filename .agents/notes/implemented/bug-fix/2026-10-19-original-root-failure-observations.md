# Agent Note: Original Root failure observations

Status: implemented

English | [中文](2026-10-19-original-root-failure-observations.zh.md)

## Problem

A coordinator can retain a task in planning after its local model call fails. Without a readable local observation, the original conversation continues to show identification in progress, and retrying can duplicate an unresolved submission.

## Decision

The Host exposes committed analysis failures through a separately negotiated `read_root_diagnostic` command. The current Account and Profile owner reads the admitted original Root, its frozen Source model, and finite original or recovery journal observations. The response matches the original Source digest and Root trace, excludes prompts, outputs, grants and exception text, and supplies no executable handle or retry permission.

The result model reads diagnostics in the background only after it has observed planning without questions or Agent output for thirty seconds. Existing refreshes drive reads; each model generation holds at most two underlying IPC read slots, with thirty seconds between completed reads for an original message. Cancellation retains a slot until the bounded Main read settles. Delivery rendering does not await diagnosis.

Delivery pages can arrive before planning metadata. While that metadata is pending for the same authorized original, the projection retains existing observations without starting a diagnostic read. Once planning, clarification, output or a read failure is known, normal eligibility rules apply.

The original message displays a localized historical failure observation while the coordinator still reports planning. The observation does not change the coordinator state or declare execution terminal. Agent output or a clarification removes the notice. Account, connection, workspace and view lifetime changes discard observations and ignore late replies. Older Main bridges receive no diagnostic action.

## Alternatives considered

**Recovery as diagnosis.** The user-level recovery path can prepare or resume analysis. A separate metadata capability keeps observation from obtaining an executable handle.

**A toast for the model failure.** A transient notice disappears while the unresolved original message remains. Journal-backed observations belong beside that message and can be read after restart.

**Awaiting diagnostics before results.** An additional Host lookup would delay a readable Agent answer. Independent background reads preserve delivery progress.

**Elapsed time as failure proof.** A slow provider may still succeed. Thirty seconds schedules a read; only a matching committed journal observation produces a failure notice.

## Consequences

The UI distinguishes a historical local failure from the coordinator's current state. Empty, unavailable and unsupported diagnostics authorize no retry. Finite reasons omit provider error details, and the initial observation window adds delay before an old planning failure becomes visible.

The [diagnostic projection](../../../../packages/client/ui-slark-agent/src/client/collaboration-diagnostic.ts) owns throttling and cancellation. Its [tests](../../../../packages/client/ui-slark-agent/tests/collaboration-diagnostic.client.spec.ts) cover finite decoding, retained IPC slots and discarded late observations. Result-model tests establish that a held diagnostic does not delay an Agent reply; view tests retain the original message without adding retry controls. These checks establish observation and rendering behavior, not installed-client tool execution or relative-native latency.

The [original Session trajectory](../feature/2026-10-07-slark-collaboration-trajectory.md) retains ownership of cloud audit and execution observations; local failures complement that history.
