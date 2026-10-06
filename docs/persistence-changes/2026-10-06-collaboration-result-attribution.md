---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-06-collaboration-result-attribution

English | [中文](2026-10-06-collaboration-result-attribution.zh.md)

## Summary

Adds collaboration-result attribution for an original-Session result relay.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-06-collaboration-result-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "dcd24094a6f73a5edc7cb775133c10b978f87f6e7d28a40147f7d720b183cc8e"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "9ed397f73c7c4d650b6b6a4e270a83185786553e3aa9d2f7624a6d6bf0ec7261"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "e7fd95afbe466d23cb3ecfdc5e69249b3c60bbfc85ebf50b9ce03ada03a31cb0"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "ea209d9e44b7740c256303d5b4fa3401ba5ff992087f5c16218ab985b20a244c"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session format 4 records remain valid. This source kind contains attribution only; unknown-kind readers preserve the logged message and metadata. It grants no authority and requires no producer-specific replay. Model checkpoint enforcement applies to Session-backed requests independently of the source kind. No released generation is rewritten.

<a id="verification"></a>
## Verification

The candidate real Loader/AgentLoop/JSONL suite passed 80 independent loss fixtures and reopened each log without the SessionController producer; the feedback and composer regression passed 204 tests.

<a id="dev-note"></a>
## Dev Note

None.
