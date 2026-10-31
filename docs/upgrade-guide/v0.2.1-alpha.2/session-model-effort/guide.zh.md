---
kind: upgrade-guide
description: "Session 模型选择的结果不再包含 adapter 默认推理强度。"
---

# Session 模型选择强度

[English](guide.md) | 中文

## 变更

当 `session.selectModel` 请求省略 `reasoningEffort` 时，返回和记录的选择也会省略它，即使 adapter 提供默认值。此前返回的选择包含解析后的默认值。

## 迁移

1. 将缺省的 `selected.reasoningEffort` 视为使用模型的 adapter 默认值，不要要求响应必须包含该字段。
2. 当 Session 需要独立于 adapter 默认值保留特定设置时，显式发送 `reasoningEffort`。
