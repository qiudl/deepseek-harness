---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-10-paired-task-target-step

English | [中文](2026-11-10-paired-task-target-step.zh.md)

## Summary

Records the slark-task-target-step message-source alternative used by the original authorized paired step.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-10-paired-task-target-step
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-31-upstream-fork-merge"
    after: "3a9d05da0fc190af27de1e581e1142f408b6cb32f11baf4c7bd9118540a59d21"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-31-upstream-fork-merge"
    after: "2d8d53345c0af04ee1490e0e759c2aa8092e9681d3c1bddd2a832897c67a6a6d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-31-upstream-fork-merge"
    after: "621c5e49e2aed80c879c44132e2683b2f5c8d8898a52d5c415986603b1967057"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-31-upstream-fork-merge"
    after: "23ae2ad7a832e0b1687f15950bba61bec960a64398349548bb6c93977e871b73"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing event alternatives and Session headers remain unchanged. New readers retain all earlier messages. Older readers preserve the unknown merge-extensible message-source kind and its JSON metadata while deriving the same ordinary user/developer message content; source metadata grants no execution or recovery permission. Paired execution still requires the current private worker capability and original authenticated Source admission. The separate paired_task_targets_v1 domain owns its own intent and receipt records; no prior Session generation or format is migrated, rewritten, truncated, or downgraded.

<a id="verification"></a>
## Verification

The generated comparison identifies only the new source alternative in agent/inbox/spliced, developer/message, session/title-llm-request, and user/message. The existing frozen paired Native regression ran 64 tests successfully (/private/tmp/req0006-paired-native-frozen-regression-26754.log), including actual Agent/Native/JSONL persistence; authority/model inputs in that component test remain controlled. This acknowledgement does not assert device or whole Task settlement.

<a id="dev-note"></a>
## Dev Note

None.
