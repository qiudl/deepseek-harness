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

`profile.remote_session.control_lease` capability 增加精确的 `control.status`、`control.acquire`、`control.renew` 和 `control.release` 命令。选定 Profile 签发进程 generation 和按 Session 递增的 epoch；每次远端 Session 修改及审批答复都携带该证明。Profile 在调用业务代码前拒绝过期或缺失的证明，已获准的写入执行期间不允许接管。Profile 重启会更换 generation，使旧证明失效。

`profile.remote_ui_read` 将启动、资源、Session 和五种精确的启动元数据读取绑定到同一有效视图租约。启动读取及无参数元数据读取要求空 `args`；`credentials/describe` 最多接受 64 个校验过的引用，只返回状态，不返回密钥值。`asset/read` 只接受插件 URL 和字节偏移；`asset/describe` 只接受最长 4096 字符的插件 URL，返回 SHA-256 和长度。Host worker 只为当前启动项列出的 URL 返回分块或摘要。请求不能指定 Profile 路径、cookie、worker token、任意 URL 或可修改状态的 Gateway 方法。每个结果仍受 64 KiB 控制帧限制。Host 仅在安装 worker 执行器后发布此 capability。 `session/collaborationSources` 只接受 `{ request: { sessionId, cursor? } }`；游标为不可变的 SHA-256 快照摘要。所属 worker 每次控制读取返回一条完整原消息，JSON 最多60 KiB；继续读取使用该消息摘要，不截断正文。

`profile.remote_ui_stream` 将一个 `session/follow` 游标绑定到同一有效视图租约和 Host 连接。打开操作只接受经过校验的 Session 或子代理地址，以及有上限的可选跟随参数。轮询立即返回空闲、最多 16 KiB 的 base64url 分块或不含细节的终止状态；关闭操作会取消 worker 读取。Host 每个游标最多缓存一个 512 KiB 事件，每条连接最多保留八个游标。每条命令都重新校验租约；租约撤销后的下一次请求或连接断开会关闭相关游标。该方法不提供通用 Gateway 流，也不暴露 worker 令牌。

`profile.model_claim_inventory` 携带 Main 持有的 Account 视图租约，返回来源摘要、最多 128 个互不重复的提供方候选、凭据是否存在、共享引用标志及无法映射记录的数量。编解码器拒绝凭据值、引用名、路径和额外字段。该只读盘点不是认领确认，也不授予凭据迁移权限。

`profile.model_claim_confirm` 针对一个凭据存在的候选项，重新校验 Account 租约和新鲜的来源摘要。它返回只在当前 Host 连接有效、60 秒内只能使用一次的确认授权。`profile.model_claim_apply` 消费该授权，并在认领事务中重新校验 Account 视图。两种结果都不包含凭据值或路径。写入失败或中断时使用独立的同账号恢复方法。

`profile.model_claim_retry` 使用与恢复相同的新鲜 Account 与保管库证明，并提交现有回执中的准确候选项、操作号和来源摘要。Host 在恢复事务前校验账本中的归属。只有在声明旧来源静止时才开放重试；状态查询与原文件恢复不需要该声明。

`profile.model_claim_recovery_inventory` 使用同一证明，但不要求候选项 ID。它最多返回 128 条属于已验证账号的脱敏回执，覆盖未完成认领和 Profile 标记尚未清除的操作。查询不启动 worker，也不授权新认领。

<a id="challenge-authentication"></a>

## 挑战认证

`profile.workspace_model_selection` 接受已验证的 Account 绑定、工作区注册表 UUID 和 Session id。精确响应包含这些身份、provider/model（各最多 256 UTF-8 字节），以及可选 reasoning effort（最多 128 字节）。调用方指定的模型、Profile 路径和额外响应字段均被拒绝。结果只是只读选择，不是可执行适配器快照或 Source 凭据；Host 必须发布已安装执行器的能力才可调用。

`profile.collaboration_registration` 在核验同一连接的 Account 绑定后，签署服务器登记请求/challenge ID、规范 nonce、有效期、HTTPS audience、environment UUID 和 Account issuer/subject。证明包含安装 UUID/公钥及当前 Host instance/process nonce。Ed25519 签名正文是 UTF-8 域 `dsh-collaboration-host-registration/v2`、NUL 与固定顺序 JSON 元组，不包含签名本身。解析器冻结精确字段并拒绝凭据。挑战须仍有效，且在五分钟内过期。服务器须另行信任安装公钥、持久保存并消费挑战、提交登记回执；此签名不授权 Source 或任务。

`profile.workspace_authority` 仅在授权 Profile 读取器确认归属后，签署服务器 nonce、Account/environment 及注册表工作区/Session 目标。读取后再次核验 Account 授权和五分钟有效期。独立签名域 `dsh-collaboration-workspace-authority/v1` 绑定完整目标及当前安装/进程，登记签名不能替代。此证明仅说明读取时的归属，不证明 Source 内容、journal 持久性或 prepared 模型配置。服务器必须认证其挑战，并在重新核验当前 Host/Account 的同一事务中消费。

`profile.source_snapshot` 在已验证的 Account 绑定下私有读取已有 Source，接受精确工作区/Session/消息/版本，另带 issuer/subject 与字节偏移。每次响应包含原描述符、偏移、总字节数（最多 1 MiB）及规范 base64url 分块；分块恰为剩余字节数与 32 KiB 中的较小值。现有 64 KiB 单帧上限保持不变。客户端限制全程 15 秒，跨块固定当前 peer 与描述符，完成严格 UTF-8 解码后校验含八字段的不透明 Source 封装。消费者校验嵌套内容；云端 seal 与 Native 签名验证完整摘要。读取不准备模型或返回可执行调用。

`profile.model_text` 接受同一 Host 连接上已验证的 Account 绑定，以及一条最多 8 KiB 的非空文本；它不会打开或改变可见 Profile 的视图租约。成功结果包含所选提供方、模型和最多 16 KiB 的回答；拒绝结果只包含分类错误码，其中 `cancelled` 与 `timeout` 分别表示取消与超时。该方法不传输 API Key、工具请求、Session id 或提供方原始错误。

`encodeHostInspectSignaturePayload(request, response)` 返回由安装级 Ed25519 密钥签名的精确 UTF-8 字节。带域隔离的声明绑定 request id、Desktop client id、challenge、选定版本、Host 与安装 id、安装公钥、generation、process nonce、capability 和可执行文件摘要。

响应里的公钥本身不构成信任。Desktop Broker 必须将其与已认证安装记录匹配，并独立比对对端可执行文件的代码签名摘要后才接受签名。迁移流程只能依据其显式同意和校验策略建立该记录；普通连接绝不能静默信任新密钥。

<a id="api"></a>

`profile.source_authority` 接受精确服务器挑战，包含 Account/environment、原始 Source 坐标、完整快照摘要与已登记 Host epoch。专用 UTF-8 签名正文由 `dsh-collaboration-source-authority/v1`、NUL 和固定顺序 JSON 元组组成。授权 Profile 必须确认匹配的持久 journal 记录后才能签名；归属或登记签名不能替代。响应不含消息、凭据或可执行调用。云端必须在核验当前 Account/Host 的同一事务中认证并消费 nonce 和快照；签名不授予目标执行权限。

`profile.reference_authority` 另将 `reference_request_digest` 绑定到独立的 Profile 传递授权。签名字节为 `dsh-collaboration-reference-authority/v1`、NUL 和 JSON `[1, sourceSigningPayload, referenceRequestDigest]`；其中 Source 签名正文保留为精确 UTF-8 字符串。Source、工作区或登记签名不能授权引用传递。Profile 授权读取器必须独立返回已提交的 Source 描述符与完整预登记请求摘要；此操作不暴露正文或文件路径。

`profile.reference_capture` 在当前令牌已验证的 Account 下接受最多 32 KiB、绑定 Source 的定位、全部或范围选择，或最多 16 KiB 的非空 Unicode 原文引用、接收对象和用户证据。它规范化私有 Profile 字段顺序，返回最多 32 KiB 的计算描述符、请求和摘要元数据，不含选中字节。父协调器须在捕获前独立确认明确分享意图，并在收到结果后校验完整请求；捕获不授予内容传递或任务受理权限。

`profile.reference_content` 仅接受当前 Account 下的原始 Source、已提交引用请求摘要和字节偏移。每次响应包含一致的 Source 描述符、请求与内容摘要、总长度和最多 32 KiB 的精确规范分块。总内容最多 1 MiB，零字节有效；客户端拼接后核验完整内容。引用字节不扩大 64 KiB 帧预算，也不确认分享或任务受理授权。

`parseHostCollaborationReferenceTarget` 校验私有 worker 查询，其中只有原始 Source 坐标及完整引用请求摘要，不能提供所选字节、快照摘要或授权。`parseHostCollaborationReferenceGrant` 独立校验返回的已提交描述符及请求摘要。

## API

`profile.collaboration_delivery` 通过顺序上传的规范 base64url 分块传输完整终态答复，每块解码后最多 16 KiB，完整封装最多 1 MiB，答复最多 128 KiB UTF-8。普通 JSON 与 64 KiB 单帧上限保持不变。最终回执不包含答复，使用规范键排序 JSON 签名域 `dsh-collaboration-delivery-receipt-v1`，绑定已验证的 Account、当前安装/进程和原 Profile 提交记录。解析或签名本身均不授予云端确认或执行权威。

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

### 远端工作区目录

远端目录选择器在 Host 的屏幕上运行。选定目录获得绑定配对客户端的 Profile 内确认；`workspace.create` 在60秒内一次消费此确认，拒绝其他路径或客户端。取消不生成确认，选择器确认不会写入日志。Host 仅在安装 worker 命令执行器后公布 `profile.remote_session.directory_picker`。

## 模型体验

无，因为这个本地 Host 控制编解码器不注册任何面向模型的内容。

#### KV Cache 影响

无直接失效；协议不会贡献模型上下文。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后工作

- 远程 Session 创建可携带不透明的工作区和会话 ID，由选定 Profile 验证工作区，并按原生 cwd 和 writer 检查幂等复用会话。会话身份复用要求 `profile.remote_session.session_reuse` 能力。传输命令不接受调用方指定的路径。
- **操作集合有明确上限**——版本 1 解析 `host.inspect`、账号与本地专用 Profile provisioning/restore/open、Profile status/lease-close、迁移导出 begin/read、扩展命令、远程 Session 命令、十种远程 UI 读取、三种原生流（`session/follow`、`workspace/follow` 与 `$events`）与通用错误。远程方法在 Host 执行器发布 capability 前仍不可用；environment、attachment 和 upgrade 操作需要显式扩展协议。
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

`parseHostRemoteSessionJson` 向私有 worker 消费者提供现有 Host JSON 限制。它复制已解析数据，拒绝非有限数字、不安全键、过深或过多节点及超限字符串；不授予操作权限。

`profile.collaboration_analysis` 只携带绑定 Account 的准备/派发命令及不可执行的准备描述或原始 JSON 输出。它不接受调用方归属摘要，将编码后的 Source 输入和解码后的输出各限制在32 KiB，验证规范 base64url、UTF-8 和对象 JSON，控制帧限制不变。派发输出另携带安装签名，绑定已验证 Account、当前 Host、原派发 grant 及已保存原始 JSON 摘要。Unix 客户端核验签名和未变输出；服务仍须分别核对当前 Source、attempt 和目标权限。

`profile.collaboration_analysis` 另支持携带有界私有输入的 `capture_reply` 和 `prepare_clarification`。补充捕获返回 `reply_source`，仅包含 captured/recovered Source 描述符；完整输入准备返回 `prepared`。命令与结果字段及操作对应的结果类别均严格核验，帧和 JSON 预算不变。补充捕获不授予模型派发资格。


`profile.root_authority` 使用独立的 `dsh-collaboration-root-authority/v1` 签名域。挑战包含完整 Source 挑战，以及 namespace、根任务/trace ID、原始命令 ID 与业务 payload 摘要。Host 在签名前从 Account 已授权的 Profile journal 读取匹配元数据，并在读取后再次检查授权和有效期。仅有 Source 签名不能授权根。新签发证明可以改变传输 nonce、请求 ID 与 Host epoch，原业务绑定保持不变。固定 UTF-8 元组由与 Slark 共用的 `tests/fixtures/root-authority-v1.json` 锁定。云端消费者仍须在根受理事务中独立持久化并消费挑战、重算业务摘要及重新核验当前 grant。

`profile.root_journal` 仅接受已有 namespace/command 和原始 Source 坐标上的 `read` 或 `accept`。回复只包含有界元数据，Source 正文通过 `profile.source_snapshot` 传输。accept 回复必须包含原根的完整原始受理回执。解析器校验字段与身份，Host 检查当前 Account 授权；已记录回执不授予执行权限。

`profile.root_analysis` 能力允许在既有分析方法上使用 `prepare_root`。输入只包含 namespace、续接策略和原 Source 输入；`root_prepared` 回复将 prepared 或 recovered 元数据绑定到已持久化根描述。仅含 Source 的回复或不同 Source 描述都会被拒绝。派发仍绑定原存活尝试，恢复出的根元数据不能创建新调用。

`profile.root_analysis_recovery` 单独启用 `read_root_output`。响应绑定原根、已消费的派发元数据与保存的 JSON 摘要，或明确报告输出缺失。历史租约到期不会删除证据，也不会授予派发权限。输出解码后仍限制为 32 KiB，完整控制帧维持 64 KiB 上限；不返回提示词或可执行 handle。

独立能力 `profile.root_lookup` 允许 `recover_root` 携带原 namespace、策略和 Source 输入。响应必须为包含不可执行 `recovered` 元数据的 `root_prepared`；不能回退到 `prepare_root` 或返回存活尝试。

`profile.root_pending_lookup` 独立允许 `reconcile_root` 查询 admitted 或 pending 根。其输入与不可执行的 recovered 响应均与 `recover_root` 相同，不授予受理、准备或派发权限。

`profile.root_live_resume` 独立允许 `resume_root`，根输入必须匹配原始准备。响应必须包含同一根的 prepared 元数据；调用模型前仍须取得当前云端派发许可。

`profile.root_planning_attempt_authority` 将新规划请求、前驱、预期计划版本、完整输入摘要和实际模型身份绑定到原 root/trace 与当前 Source 挑战。独立签名域不能复用根受理或 Source 签名。精确解析器复制并冻结元数据；固定 UTF-8 元组和 Ed25519 夹具与 Slark 共用。`matchHostRootPlanningAttemptDescriptor` 比对私有持久元数据与挑战；解析和签名不确认云端 nonce 消费、前驱可替代性或派发权限。

`profile.root_planning_attempt` 单独声明通过 `profile.collaboration_analysis` 提供新准备和派发。`prepare_root_attempt` 只接受原根查询，返回包含有界持久元数据的 `root_attempt_prepared`；调用方不能覆盖模型、前驱或归属。`dispatch_root_attempt` 携带新请求 ID 和父协调方已认证的 grant。私有检查使用 worker analysis token，不是 Main 命令。描述符解析器匹配根坐标及可选尝试身份，不建立生命周期或云端权限。

`read_root_attempt` 要求 `profile.root_planning_attempt_recovery`，仅返回原根元数据、最新尝试、已消费授权及可选的已保存输出。解析器绑定原 Source、trace、模型和 manifest，核验输出摘要，并保留已过期的派发事实。这些证据不授予新派发或租期延长。

`profile.root_execution_journal` 启用私有 analysis 传输上的 `root_execution_journal` 命令。请求操作及响应记录是最大 8 KiB 的独立 JSON，调用方不能提供 Account 绑定摘要。Profile 校验操作字段及持久化 root/task 身份，Main 校验记录摘要和已认证的云端回执。null 读取结果仅表示本地没有命令，不证明云端未受理，也不授予执行权限。

独立的 `profile.root_feedback` 能力允许在同一私有分析传输中传递有界的 `root_feedback` 操作与观察记录。Account 绑定仍由父进程负责。观察记录区分持久入队、已接纳的 Session 上下文及已观察到的助手续跑；其中不含结果文本或签名，不能独立认证云端消费。

消费回执采用独立的 `dsh-collaboration-consumption-receipt-v1` 签名域。提交将原根 trace、执行命令、消费尝试和逻辑步骤绑定到实际 Session 事件坐标、首次持久化前缀及本地 journal 提交。投递签名不能替代消费证据。这些编解码器仅确立语法，不授予权限。
