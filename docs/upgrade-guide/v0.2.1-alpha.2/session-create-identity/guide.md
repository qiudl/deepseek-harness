---
kind: upgrade-guide
description: "Session creation may return a different identity when a named Session cannot be reused."
---

# Session creation identity

English | [中文](guide.zh.md)

## Change

`session.create` treats a named Session as a candidate for a new conversation. When it has started a turn, is unavailable for writing, or fails the placement rule, the Host creates a new Session and returns its identity. Callers that require the exact named Session must opt into exact adoption.

## Migration

1. Set `exactAdopt: true` together with `sessionId` when an existing identity must be adopted. A cwd, preset, ownership or writer conflict is reported instead of creating a replacement.
2. For new conversations, use the `sessionId` returned by `session.create` for workspace references and subsequent operations. When workspace attachment or collaboration marking fails, inspect the error details and preserve the reported Session identity for recovery.
