---
description: "在 Slark Desktop 的 DSH 会话中提及获分配的企业 Agent，并在原会话查看任务结果。"
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-slark-agent

[English](README.md) | 中文

## 概述

在 Slark Desktop 的 DSH 会话中输入 `@`，可查找获分配的企业 Agent。选择 Agent 并发送纯文本问题后，会创建 Slark 任务；结果显示在同一会话中。Agent 列表要求 Account Profile 在线，并且 Desktop 桥确认当前可调用。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制和待办事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Web bundle 自动挂载此包，无需额外配置。在 Slark Desktop 中输入 `@`，在 Slark 企业 Agent 分组下选择 Agent，并发送纯文本任务或问题。选中的芯片可位于句子任意位置，显示为 `Agent · 项目空间`；候选描述还显示所属企业。例如，在「请 @Guide · qiu-slark 检查登录问题」这句话中选中 Guide。任务区在原会话显示结果；未完成任务经过 120 秒后标记为后台任务。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

Client 来源通过 Desktop 桥读取绑定当前账号的分配。每个编辑器芯片保留分配、项目、Agent、企业和发布版本；Slark 在调用准入时再次检查分配授权。来源为单个结构化 Agent 芯片认领整条草稿，问题仅移除该芯片，并拒绝普通模型序列化。发送失败保留草稿，重试时重新裁决。新引用通过 Web Crypto SHA-256 将准入键绑定到问题内容：原样重试复用键，修改问题后生成新键；旧引用保留原有键和芯片文字。Web Crypto 不可用时拒绝提交。Desktop 桥只提供目录摘要。不发布 companion。

</details>

-----

<a id="model-experience"></a>

## 模型体验

无；Agent 提及经 Slark Desktop 桥处理，不进入普通 DSH 模型请求。

#### KV Cache 影响

无；此插件不组装或发送 DSH Provider 请求。

## 已知限制和待办事项

<a id="known-limitations-and-deferred-work"></a>

Agent 提及依赖当前账号的 Slark Desktop 桥报告可调用。没有该桥时，普通 `@` 引用仍可使用。

- **仅 Desktop 可用的目录** — 独立的 DSH 浏览器会话无法列出或调用 Slark Agent。
- **单个目标** — 每次发送一个明确选中的 Agent 和非空纯文本问题；多个提及、混合引用与附件均会被拒绝。
- **协同 2.0 待接通** — 本次改善已有的单目标入口；工作区项目空间选择与跨目标模型规划尚未接入，规划失败不能降级到本入口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护人员上下文 — 点击展开</summary>

无。

</details>
