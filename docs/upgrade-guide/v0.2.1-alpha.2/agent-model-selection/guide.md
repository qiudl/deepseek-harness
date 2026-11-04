---
kind: upgrade-guide
description: "Custom Agent implementations must expose the Session-backed model selection owner."
---

# Agent model selection ownership

English | [中文](guide.zh.md)

## Change

Live Agents expose `model` as the owner of durable model choices. Agent drivers register the model-selection projection and install its scoped prompt and request listeners; callers that installed a separate mutable selection reference must use the Agent owner instead.

## Migration

1. Update custom Agent implementations to supply a Session-backed `AgentModel` and register its projection before use.
2. Replace separate selection references with `agent.model.select(...)`; retain a turn pin when a caller promises a fixed route for an admitted turn.
3. Verify a selected model survives Session resume and that concurrent route changes take effect at the intended turn or step.
