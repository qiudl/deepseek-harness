---
kind: upgrade-guide
description: "自定义 Agent 实现必须提供基于 Session 的模型选择所有者。"
---

# Agent 模型选择所有权

[English](guide.md) | 中文

## 变更

活动 Agent 通过 `model` 拥有持久模型选择。Agent 驱动器注册模型选择投影并安装其作用域内的提示词和请求监听器；原先安装独立可变选择引用的调用方必须改用 Agent 所有者。

## 迁移

1. 更新自定义 Agent 实现，在使用前注册投影并提供基于 Session 的 `AgentModel`。
2. 将独立选择引用替换为 `agent.model.select(...)`；调用方承诺已准入轮次使用固定路由时保留轮次固定。
3. 验证模型选择在 Session 恢复后仍然有效，并确认并发路由更改在预期轮次或步骤生效。
