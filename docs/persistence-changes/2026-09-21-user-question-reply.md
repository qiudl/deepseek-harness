---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-user-question-reply

English | [中文](2026-09-21-user-question-reply.zh.md)

## Summary

Integrates user-question-reply attribution with the Slark collaboration-result history.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-user-question-reply
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-06-collaboration-result-attribution"
    after: "fca6a6cdab6313eae42e0d8a1533e795a7cbce20cf88858febe0c2bcb73e4346"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-06-collaboration-result-attribution"
    after: "57b8dc41ba4243fbbdfae7d1ad595561d8608a108235229c31409c4120b2bfba"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-06-collaboration-result-attribution"
    after: "de4a9471c9747581aa969d4b6de74ce4f9257fe5d02542f7b096ff884c3a9a08"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-06-collaboration-result-attribution"
    after: "ca818cdfb08e9ce763b9d63783667ee405531595750090dba92c15591645402b"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session format 4 records remain valid. Both source kinds carry attribution only; unknown-kind readers preserve the logged message and metadata. Neither grants authority or requires producer-specific replay. The incoming user-question-reply acknowledgement follows the accepted Slark collaboration-result acknowledgement when integrated into this fork. No released Session generation is rewritten.

<a id="verification"></a>
## Verification

The rc.2 integration passed the JSONL catalog migration and native source admission tests, the v3-to-v4 migration tests, the Host legacy migration source tests, and 182 YAML-loaded Slark composer regressions. Historical format inventories verify complete references for v0 through v4.

<a id="dev-note"></a>
## Dev Note

None.
