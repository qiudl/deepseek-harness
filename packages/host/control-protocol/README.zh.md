---
description: "Desktop 与 DSH Host 身份协商和控制错误所用的严格规范化线协议。"
kind: "package-reference"
---

# dsh-host-control-protocol

[English](README.md) | 中文

## 概述

这个零 I/O 库拥有 Desktop Broker 与唯一 DSH Host Supervisor 共享的本地控制线协议。版本 1 从带签名的 `host.inspect` 挑战交换开始，并包含账号与本地专用 Profile 操作、lease 与迁移导出载荷。后续操作必须保留本包的规范 JSON-Lines 信封、品牌化身份、有界帧和脱敏错误词汇。

该传输不是 JSON-RPC。畸形行是必须关闭连接的协议违规，不能被忽略后继续读取。

## 目录

- [线协议约定](#wire-contract)
- [挑战认证](#challenge-authentication)
- [API](#api)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)

<a id="wire-contract"></a>
## 线协议约定

- 每帧恰好一个 UTF-8 JSON 对象和一个结尾 LF；拒绝 CRLF、多行、重复或乱序键、未知字段、非规范数字和尾随数据。
- JSON 对象最多 65,536 个 UTF-8 字节，不含 LF。传输层必须在缓冲时执行同一上限；字符串编解码器无法收回调用方已经累积的字节。
- UUID 使用小写 RFC 变体；nonce 与 Ed25519 材料使用规范无填充 base64url；SHA-256 摘要使用小写十六进制。
- capability 是排序、去重的点分 token，且必须包含 `host.inspect`；未协商方法显式拒绝。
- 错误只暴露稳定 code、是否可重试和 correlation id；异常文本和本地路径不得进入帧。

协商后的 `profile.extensions` 方法携带 Main 持有的租约，以及清单、准备、提交、状态或取消命令。准备载荷上限为 32,768 个 UTF-8 字节；结果仅包含计划、有界元数据或持久回执状态。插件继续执行的操作类型必须为字面字符串 `install`、`update` 或 `remove`；数组和对象直接拒绝，不做强制转换。种类支持由 Host 执行器决定，能够解析某种类不代表安装能力可用。 技能清单可包含布尔字段 `skill_archives`；缺失时调用方不能认定支持资源包。资源包计划在同一载荷上限内携带 URL 和摘要元数据，不携带 ZIP 字节。

`profile.remote_session` 把封闭的 Session 与审批命令集合绑定到 Main 持有的一个视图租约。每条命令另带一个 UUID 幂等键；命令不能选择 HTTP 路径、Profile 根目录、凭据、cookie、启动 token 或任意方法。提示文本、标识符、标题、等待间隔、游标、JSON 深度、节点数、字符串和完整帧均有上限。能够解码该方法不代表功能可用；Host 只有在安装受租约授权的 worker 执行器后才能发布对应 capability。

`profile.remote_ui_read` 将 `boot/injections`、`session/list`、`session/page` 或 `session/modelCatalog` 四种读取绑定到同一有效视图租约。启动读取要求空 `args`，返回当前 Profile 的结构化启动项；其他读取接受有界 `args`。请求不能指定 URL、Profile 路径、cookie 或 worker token。结果受 64 KiB 控制帧限制；大页和流式事件需要独立传输。Host 仅在安装 worker 执行器后发布此 capability。

`profile.model_claim_inventory` 携带 Main 持有的 Account 视图租约，返回来源摘要、最多 128 个互不重复的提供方候选、凭据是否存在、共享引用标志及无法映射记录的数量。编解码器拒绝凭据值、引用名、路径和额外字段。该只读盘点不是认领确认，也不授予凭据迁移权限。

`profile.model_claim_confirm` 针对一个凭据存在的候选项，重新校验 Account 租约和新鲜的来源摘要。它返回只在当前 Host 连接有效、60 秒内只能使用一次的确认授权。`profile.model_claim_apply` 消费该授权，并在认领事务中重新校验 Account 视图。两种结果都不包含凭据值或路径。写入失败或中断时使用独立的同账号恢复方法。

`profile.model_claim_retry` 使用与恢复相同的新鲜 Account 与保管库证明，并提交现有回执中的准确候选项、操作号和来源摘要。Host 在恢复事务前校验账本中的归属。只有在声明旧来源静止时才开放重试；状态查询与原文件恢复不需要该声明。

`profile.model_claim_recovery_inventory` 使用同一证明，但不要求候选项 ID。它最多返回 128 条属于已验证账号的脱敏回执，覆盖未完成认领和 Profile 标记尚未清除的操作。查询不启动 worker，也不授权新认领。

<a id="challenge-authentication"></a>
## 挑战认证

`profile.model_text` 接受同一 Host 连接上已验证的 Account 绑定，以及一条最多 8 KiB 的非空文本；它不会打开或改变可见 Profile 的视图租约。成功结果包含所选提供方、模型和最多 16 KiB 的回答；拒绝结果只包含分类错误码，其中 `cancelled` 与 `timeout` 分别表示取消与超时。该方法不传输 API Key、工具请求、Session id 或提供方原始错误。

`encodeHostInspectSignaturePayload(request, response)` 返回由安装级 Ed25519 密钥签名的精确 UTF-8 字节。带域隔离的声明绑定 request id、Desktop client id、challenge、选定版本、Host 与安装 id、安装公钥、generation、process nonce、capability 和可执行文件摘要。

响应里的公钥本身不构成信任。Desktop Broker 必须将其与已认证安装记录匹配，并独立比对对端可执行文件的代码签名摘要后才接受签名。迁移流程只能依据其显式同意和校验策略建立该记录；普通连接绝不能静默信任新密钥。

<a id="api"></a>
## API

| 导出 | 职责 |
|---|---|
| `decodeHostControlFrame(source)` | 严格解析并规范化恰好一帧。 |
| `encodeHostControlFrame(frame)` | 运行时校验并发出恰好一帧规范数据。 |
| `encodeHostInspectSignaturePayload(request, response)` | 生成由黄金向量固定的域隔离签名字节。 |
| `HostControlProtocolError` | 带稳定 code 的脱敏本地失败。 |
| `HOST_CONTROL_MAX_FRAME_BYTES` | 传输共享缓冲上限。 |

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

参见[单 Host 控制协议 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-single-host-control-protocol.zh.md)。

</details>

<a id="model-experience"></a>
## 运行时不变量

不发布运行时不变量伴随插件：编解码器在输入边界验证完整的消息值结构。

## 模型体验

无，因为这个本地 Host 控制编解码器不注册任何面向模型的内容。

#### KV Cache 影响

无直接失效；协议不会贡献模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **操作集合有明确上限**——版本 1 解析 `host.inspect`、账号与本地专用 Profile provisioning/restore/open、Profile status/lease-close、迁移导出 begin/read、扩展命令、远程 Session 命令、四种远程 UI 读取与通用错误。远程方法在 Host 执行器发布 capability 前仍不可用；environment、attachment 和 upgrade 操作需要显式扩展协议。
- **传输上限由外部执行**——Unix domain socket carrier 必须在字节上限停止读取，并在首次 codec 失败时关闭连接。
- **密码学策略由外部执行**——密钥持久化、代码签名检查、挑战签名与验证、重放存储和密钥轮换属于 Host identity 与 Desktop broker 包。

MCP 清单可声明 `mcp_remove: true` 和 `mcp_update: true`；缺失表示对应操作不可用。两个字段必须为布尔值，且只允许出现在 MCP 清单中。

技能清单可包含 `skill_invocation: true`，条目可包含成对的布尔字段 `model_invocable`/`user_invocable`。能力缺失时禁用编辑；条目标记缺失表示本地调用配置未知。调用字段只允许出现在技能清单中，不携带指令正文或路径。

技能清单可声明布尔字段 `skill_files`，表示支持经确认的 Markdown 导入；缺失表示不支持。原始 Markdown 放在有大小限制的 JSON 准备载荷内，不传递任意本地路径或上传压缩包。

技能清单可声明布尔字段 `skill_replace`，表示支持经明确确认后替换一个现有 flat/bundle 条目。受大小限制的准备载荷包含条目 ID 和 Markdown；替换与新文件导入分开，始终不接受文件系统路径。

`skill_remove` 是仅允许出现在技能清单中的可选布尔能力。成功删除回执可在可选 reason 字段后包含 `skill_source`：`absent`、`user-dsh`、`user-agents`、`custom`、`bundled`、`runtime` 或 `other`。它描述完成时的默认预设观察结果，不是实时来源清单。缺少该字段的旧回执仍可读取。不返回路径、指令正文或任意来源字符串。

插件清单可声明布尔字段 `plugin_toggle`，条目可包含 `plugin_state`：`enabled`、`disabled`、`mixed` 或 `unsupported`。其他市场不允许这些字段。状态描述组合配置而非实时健康；成功变更回执仍须经 worker 生效确认。能力或条目状态缺失时禁用 Desktop 控件。

插件清单另可声明可选布尔字段 `plugin_update` 和 `plugin_remove`，其他市场不允许这两个字段。Desktop 更新要求受管条目已启用，并通过不可变同名来源预检；卸载接受可独立管理的启用、停用或混合条目。相应能力缺失时控件保持禁用。两种操作复用现有绑定 Profile 的准备/提交/回执合同。

插件清单条目使用不透明包 ID 和有长度限制的 npm 包名，支持带作用域的名称；MCP 和 Skill 清单标签保留原有字符集限制。

技能条目可在调用开关之后成对携带 `skill_source` 与 `skill_status`，仅 `shadowed` 条目随后携带 `effective_source`。来源限定为 `user-dsh`、`user-agents`、`custom`、`bundled`、`runtime` 和 `other`；状态为 `effective`、`shadowed` 或 `not_visible`。这些字段仅适用于技能列表，不包含路径，区别于删除回执在完成时记录的来源。

结果未知的 Skill 删除回执可通过 `skill_restore` 返回有界的 flat/bundle 条目 ID；未知 MCP 回执则可声明 `mcp_restore: true`。插件启停回执可通过 `plugin_restore` 返回有界 npm 包名。全部恢复能力字段互斥，不支持或已恢复时省略。`restored_by` 将历史未知回执关联到成功恢复 UUID，与任一恢复能力字段互斥。恢复回执用 `restores_operation` 指向原操作，两个关联字段均不得指向回执自身。可选字段在 `skill_source` 之后按 `skill_restore`、`mcp_restore`、`plugin_restore`、`restored_by`、`restores_operation` 排序，不传输私有检查点摘要或文件路径。

未知包操作回执可通过 `plugin_complete` 返回闭合的 `action`、`package_name` 和可选 `spec` 字段。动作限定为 install/update/remove；安装和更新要求有界来源，卸载省略来源。该能力与恢复能力及成功解决关联字段互斥。继续执行使用独立的 `completed_by` 和 `completes_operation` UUID，拒绝指向自身及与对应恢复关联字段混用。回执规范顺序在 `plugin_restore` 后加入 `plugin_complete`，随后为 `restored_by`、`restores_operation`、`completed_by` 和 `completes_operation`。意图阶段、原依赖摘要和无关状态摘要保留在 Host 私有记录中。
