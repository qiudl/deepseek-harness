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

Web bundle 自动挂载此包，无需额外配置。Desktop 启用项目范围模式后，输入区提供可折叠的 Slark 协同区域。为当前 DSH 工作区多选 Slark 项目空间并应用；取消丢弃草稿，未配置工作区默认不选任何空间，未归属工作区的会话不能设置范围。Agent 名称带项目空间名称。Main 启用新版提交且服务端确认目标支持独立执行后，在聊天中输入 `@`、选择 Agent，并用自然语言描述任务即可发送，无需打开面板、填写任务表单或确认预览。其他目录项仅供查看；范围模式拒绝旧 Agent 引用和旧调用。日常聊天无需打开该区域。

在已有单目标模式下，在 Slark Desktop 中输入 `@`，在 Slark 企业 Agent 分组下选择 Agent，并发送纯文本任务或问题。选中的芯片可位于句子任意位置，显示为 `Agent · 项目空间`；候选描述还显示所属企业。例如，在「请 @Guide · qiu-slark 检查登录问题」这句话中选中 Guide。任务区在原会话显示结果；未完成任务经过 120 秒后标记为后台任务。

-----

<a id="understand-the-implementation"></a>

## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

Client 来源通过 Desktop 桥读取绑定当前账号的分配。每个编辑器芯片保留分配、项目、Agent、企业和发布版本；Slark 在调用准入时再次检查分配授权。来源为单个结构化 Agent 芯片认领整条草稿，问题仅移除该芯片，并拒绝普通模型序列化。发送失败保留草稿，重试时重新裁决。新引用通过 Web Crypto SHA-256 将准入键绑定到问题内容：原样重试复用键，修改问题后生成新键；旧引用保留原有键和芯片文字。Web Crypto 不可用时拒绝提交。范围投影通过输入区注册提供的框架快照 hook 观察 Workspace Controller 中的真实会话归属，归属或桥接身份变化时清空缓存并忽略迟到响应，每次保存后重新读取权威范围。保存冲突或结果不确定时不重放草稿。项目和 Agent 分页保留显式续页状态；可见项目为空仍可能有下一页，未加载的已选空间也保留选择。Desktop 桥只提供目录摘要。不发布 companion。

范围引用保留选择时的工作区、会话、目标、能力摘要和一个 UUID。整条原始草稿及 UTF-16 芯片范围传给 Main；页面不提供 owner、凭据、模型或 Task ID。发送结果不确定时保留草稿和 Source 身份，编辑文字不会生成替代 Source；Main 与 Native 拒绝已捕获身份的内容变化。重新明确选择 Agent 才建立新的用户请求。工作区、归档或桥接身份变化，以及错误来源或迟到响应，都不能清空原草稿。Main 负责分析、冻结和受理；受理不等于执行完成。

</details>

-----

<a id="model-experience"></a>

## 模型体验

间接通过 Session Controller 的原始协同 Source 分析进入模型；普通聊天序列化仍拒绝 Agent 芯片。

#### KV Cache 影响

Session Controller 为每条 Source 分析组装独立请求；此插件不增加普通会话历史前缀。

## 已知限制和待办事项

<a id="known-limitations-and-deferred-work"></a>

Agent 提及依赖当前账号的 Slark Desktop 桥报告可调用。没有该桥时，普通 `@` 引用仍可使用。

- **仅 Desktop 可用的目录** — 独立的 DSH 浏览器会话无法列出或调用 Slark Agent。
- **单个目标** — 每次发送一个明确选中的 Agent 和非空纯文本问题；多个提及、混合引用与附件均会被拒绝。
- **协同 2.0 联调待完成** — 范围内单目标聊天提交已调用 Main 的原始 Source 捕获、规划与自动受理；范围和执行开关默认关闭。真实 Provider/GUI 闭环、原会话新版回复与历史、多目标和显式引用仍需联调和验收；范围模式不会回退到旧调用入口。

<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护人员上下文 — 点击展开</summary>

[工作区项目范围决策](../../../.agents/notes/implemented/feature/2026-10-03-slark-workspace-project-scope.zh.md) 记录范围模式关闭旧入口的原因。

</details>
