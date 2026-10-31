---
kind: upgrade-guide
description: "Session model selection omits adapter-default reasoning effort from the selected value."
---

# Session model selection effort

English | [中文](guide.zh.md)

## Change

When a `session.selectModel` request omits `reasoningEffort`, the returned and recorded selection omits it even when the adapter supplies a default. Previously the returned selection included the resolved default.

## Migration

1. Treat an absent `selected.reasoningEffort` as the model's adapter default. Do not require the field in the response.
2. Send an explicit `reasoningEffort` when the Session must retain a particular value independently of the adapter default.
