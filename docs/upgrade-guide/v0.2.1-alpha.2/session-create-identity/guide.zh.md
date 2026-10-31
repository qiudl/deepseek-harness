---
kind: upgrade-guide
description: "指定的 Session 无法复用时，Session 创建可能返回不同身份。"
---

# Session 创建身份

[English](guide.md) | 中文

## 变更

`session.create` 将指定的 Session 视为新会话的候选。当它已开始轮次、无法取得写入权或不满足位置规则时，Host 创建新的 Session 并返回其身份。要求精确指定身份的调用方必须选择精确采用。

## 迁移

1. 需要采用现有身份时，同时设置 `sessionId` 和 `exactAdopt: true`。cwd、预设、所有权或写入冲突会被报告，不会创建替代身份。
2. 对新会话，在工作区引用和后续操作中使用 `session.create` 返回的 `sessionId`。工作区附加或协作标记失败时，检查错误详情并保留其中报告的 Session 身份以便恢复。
