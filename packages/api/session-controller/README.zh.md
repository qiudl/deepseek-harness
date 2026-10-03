---
description: "Host 与 Client 会话控制：创建、恢复、提示、跟随历史并投影实时会话状态。"
kind: "package-reference"
---
# Session Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-session-controller` 拥有 Host 的 `ctx.sessionController` 服务，以及生成的 Client `session`、`skills` 和 `fileReferences` Remote namespace。它提供 Session 生命周期与历史、Host generation 模型目录、工作区路径打开、用户可调用 skill（技能）发现和 Agent（智能体）范围的文件引用。当 Client 需要按 Session 寻址的操作时，请通过 API Gateway 使用它。

## 目录

- [使用本包](#use-this-package)
- [Client 引用](#client-references)
- [会话媒体引用](#session-media-references)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

历史页与 follow opening 快照为每个持久 Session 事件携带一条 `{ type: 'event', event: SessionWireEvent }` record。Client 把每条已接受 record 保留为一个持久 `SessionEventLikeEntry`；Assistant token 边界保留在 `assistant/message` 或 `assistant/attempt` 的紧凑流内。工具参数、结果内容、失败信息和 `tool/result.data.meta` 原样通过；控制器不解析工具定义、不运行展示转换器，也不附加 UI 数据。

Client journal 在发布 follow 快照、live entry 或历史页之前验证精确的 V3 事件 envelope。它复用浏览器安全的 Session validator，检查必需的 surface marker、精确的 replacement endpoint、更早且唯一的 source seq、内嵌 Assistant 提供方元数据、request header 可选字段的省略规则以及工具错误一致性。无效 record 直接失败，不删除字段或归一化；范围成员与来源存在性仍由 Host 的持久日志检查。

每个 endpoint 都声明自己的激活策略。列表只读取持久化 header 与 projection cache row，绝不调用逐 Session stat 或打开冷 Session body。当前格式 cache identity 可以提供全部列表 hint；生命周期匹配的 predecessor cache 只能提供版本兼容的 title，作为可能过时的展示事实，绝不能作为权威 fold seed。搜索、附件、历史页、日志跟随、skill 发现和工作区路径打开可以在不激活 Agent 的情况下检查 persistence；`canOpenWorkspacePath()` 无需指定 Session 即可报告原生打开能力。取消要求 live 状态；queue 变更、模型、重命名、prompt 和文件引用操作可以解析或恢复普通 Session。`session.delete` 会持久归档已知 Session，而不删除其 append-only 日志；随后清空排队工作、取消已挂载 Agent，并等待其进入 idle 后才确认请求；之后的列表与搜索会省略已归档 Session。提示词会在解析 Agent 或追加 Session 事件前，拒绝既没有非空白文本也没有附件的 content；queue edit 只接受非空文本 content。prompt 准入从注入的 [`fileUploads`](../../client/file-upload/README.zh.md) Host 服务取得不透明凭证，在把完整有序内容列表交给 `ctx.attachments` 前解析每个属于同一 Agent 的凭证。`requestId` 已进入 queue 或日志时，prompt 重试直接返回原来的接受结果，不会重复插入消息。只有 create 与 fork 会直接创建新 Agent。该服务把同一套感知 preset 的恢复策略和 subagent ownership fence 同时用于自身方法，以及其他 Remote namespace 使用的 Typert Agent 与 Session lookup。Queue 变更只有一个狭窄例外：当前 projection identity 为 continuable 且来自自身非 seed suffix 的在线 child，可以在两个 inbox 目标上使用普通 Edit、Remove 与 QueueDock Steer action。One-shot、缺失、未知、损坏、仅含 seed identity 或冷 child 继续被拒绝，且不会恢复。skill 目录优先使用已有 live Agent，否则使用所记录 preset 的常驻 scope，因此列表查询绝不会启动 Agent。经过鉴权的文件交付路由通过 `workspaceDesktop()` 获取提供服务的 Host 名称和文件管理器行为。`openWorkspacePath({ path, action: "reveal" })` 将文件管理器导航委托给原生适配器；省略 `action` 时打开默认应用。

Client 列表刷新保留未变化的行对象，并在顺序和值均相同时复用条目数组。每行的 `retainedBy` 包含本地引用来源的正计数；Host 元数据刷新不能覆盖它们。缓存成员检查使用每次刷新构建的 ID 集合，因此对账成本随当前列表和保留缓存的规模线性增长。

可信 Host 调用方可以用 `inspectWorkspaceModelSelection(sessionId, workspaceId, signal?)` 读取不可变的 `WorkspaceModelSelection`：注册表中的 `workspaceId`、`sessionId`，以及只含 provider、model 和可选 reasoning effort 的 `selection`。读取会在异步操作后重新检查注册表成员关系、规范化 cwd 和归档状态；工作区不存在、子 Agent、归属变化或取消均会拒绝。冷读取取得只读句柄；已附着会话读取当前选择状态。两条路径都不会激活 Agent、追加事件或调用 provider。该方法没有 Client Remote 路由，也不提供账户认证或可执行适配器快照。 此 Host 读取绑定到提供服务的 Profile 上下文，调用方的 Cordis 作用域不能替换其注册表。

`prepareWorkspaceModelSnapshot(sessionId, workspaceId, signal)` 使用该来源选择准备完整 [LLM 快照](../../llm/llm/README.zh.md)，随后重验归属与选择。准备期间发生变化会被拒绝，返回工作区/会话身份与当前进程的一次性调用。这个仅供 Host 使用的方法采用提供服务的 Profile 上下文，不暴露 Remote 入口，不激活 Agent，不写 Session 事件，准备阶段不发送模型请求。调用方负责取消、Source 认证及 journal；元数据不是授权证明。

可信 Profile 协调器可以从本 Host 包导入 `openCollaborationSourceJournal`，传入自己配置的 `storageDomain` form。独立的 `collaboration_source_v2` 领域在规划前保存 Source 原文、已分类的 mention 及 prepared 模型元数据。`capture` 在持久化后返回脱离输入且深度冻结的快照；相同重试返回原条目 UUID 和首次提交版本，相同工作区/会话/消息/revision 下内容变化则拒绝。该领域不追加普通 Session 事件，也不发送模型请求。

journal 最多保留 128 条尚未路由的 Source，不会为了接收新来源而淘汰原记录。写入确认失败后，调用方必须关闭并重新打开 journal，按原身份核对结果。损坏数据、未知持久版本、被改动的内容摘要和不匹配的记录键会令打开失败，同时保留原有字节。调用方必须在捕获前校验 Account 和工作区归属、分类主动 mention，并提供实际 prepared 元数据；journal 不认证这些事实。

`captureCollaborationSource(input, signal)` 是拥有该 journal 的 Profile Host 协调方法。它接收 Source 坐标、原文与已分类 mention，通过自身 WorkspaceRegistry 和 LLM runtime 获取模型快照，持久化后重验 Session 归属与选择。只有首次成功捕获返回当前进程的 prepared 调用；重复发送与 Profile 重启返回原快照，不产生另一个调用或模型请求。协调器在排队前复制输入，拒绝调用方提供模型或提交元数据，取消受 Profile 生命周期约束。取消读取会释放捕获队列；已接受的写入排空后才关闭。该方法没有 Remote 入口；Account 认证、mention 分类、聊天路由与云端 Source 授权仍由调用方负责。

Client 适配器提供 `SessionEventStream`，即绑定到一个普通 Session 或 direct subagent address 的 Gateway `RemoteJournalStream`。它在读取首个 page 前打开 follow，只发布连续的 `replace`、`prepend`、`append` 与 `settle-assistant` 变更，并通过 tail page 修复重连或 seq 缺口。向后分页有两个动词：`loadOlder()` 拉一页 50 条消息，而 `loadThrough(seq)`——轮次跳转加载器——按每页 200 条消息循环拉取直到窗口覆盖目标 seq，重复调用会下调共享目标，遇到无进展的页即停止，忙碌状态复用同一个 `loadingOlder` 快照位。Web 适配器显式选择接收无 cursor 的 Assistant frame：每个 opening 携带活跃 attempt 的 `startedAfterSeq`、`nextIndex` 与紧凑 stream，每个 stream member 都成为排在持久 cursor 之间的 Client-only `assistant/live-chunk` 条目。Host 会随该 baseline 捕获 follower 本地到达序号，并抑制该 cut 及之前的 buffered frame；replacement Agent 可以从 revision 一重新开始。活跃 opening 之后到达的持久 `assistant/message` 或 `assistant/attempt` 只有在其 seq 晚于 `startedAfterSeq` 且轮次与步骤匹配时才会保持暂存；匹配的 end type、seq 与 index 会发布一个具名 settlement delta，删除该 attempt 的瞬态 row、加入持久条目，并保留同一步骤中更早的 retry。已知 attempt 的 revision、密集 index 或 settlement 缺口会重新打开 follow；若 controller 错过 start，则忽略 unknown-attempt frame，并正常发布其持久 settlement。Abandoned end 会发布不含持久条目的 settlement delta，使瞬态 row 立即退出。持久缺口修复 page 不携带 Assistant baseline，因此 held notification 会重新打开 follow 一次，以取得配对的 page 与 baseline。每条历史 record 只覆盖自身的事件 seq。业务、persistence 或无法恢复的连续性错误会终止 stream，只有物理载体断开才触发自动恢复。`SessionControlStream` 是 Gateway `RemoteSnapshotStream`；每代都以完整的进程本地 baseline 开始，因此重连会替换 jobs 和 projection 状态，而不会把瞬态值当作 durable event。每次 Host generation 就绪时，同步的 Client 订阅会先清除保留的投影值及其水位，再刷新查询并重新打开 control stream，其中也包括 control baseline 中没有列出的 Session。首次 control stream 会等待 generation 就绪，确保其 opening 值不会先于旧状态清理到达。上一代尚未完成的 list 响应无法重新发布这些值。同一 generation 内，延迟到达的 control baseline 不能覆盖或清除较新的 list、history 或 live 值。持久 `inbox` 投影通过与其他投影相同的冷读取和重连路径传输两份待处理列表。Client Agent 上下文提供独立 [`fileUpload`](../../client/file-upload/README.zh.md) 服务使用的身份；Session 对象提供生命周期、prompt、queue 与历史操作，不提供文件传输。

Session 对象还承载本地提交回显：`session.beginSubmission` 在调用方序列化与提示词之前，同步把一条回显写入 `SessionSnapshot.pendingSubmissions`，会话 UI 因此能在点击提交的当帧显示消息。回显按顺序存放图片预览与持久文件引用。Session 根据当前运行状态与请求的投递模式推导其 `transcript`、`queued` 或 `steering` 位置，并在序列化期间保留该位置。提示词的 `requestId` 是关联标识：Host 把它回显为 durable user source 的 `rpcId`，`inbox` 投影中的待处理消息也保留同一 source。回显在观察到其 durable event 或 queue occurrence 后延迟一个动画帧退休，带标识的提示词失败或被放弃时立即退休，销毁时按 failed 退休。每次退休恰好触发一次 `onRetire`；observed 退休还会携带有序的持久附件引用，让 composer 释放成功卡片并保留失败草稿。回显只存在于 Client 内存；刷新与重连只从持久事件重建会话。


面向用户调用的 `skills/list` 元数据包含胜出提供方可选的指令文件 `path`。输入框可据此预览文件，无需加载每个 skill 的正文或激活冷态 Agent。

分叉复制截至选中已结束轮次的历史，并包含其 `turn/end`。该位置之后的事件均被排除，包括排队输入和模型设置变更。省略锚点或锚点超出日志末尾时，选择最后一个已结束轮次；位于未结束轮次内的锚点会被拒绝。

恢复会话时若已有写句柄占用，返回 `session/writer-held`，并携带会话 id；其他恢复失败仍返回 `gateway/internal`。

<a id="client-references"></a>
## Client 引用

`sessions.retain(target, { source, signal? })` 立即获取一个精确 Client generation 的引用，并启动其共享的首次历史打开。目标是已知 Session id 或持久的直接父子 subagent 地址；Host 在打开历史时校验显式地址。返回引用支持幂等的 `release()` 和 `Symbol.dispose`；其 `ready` Promise 跟随共享的 `Session.open()` 结果，并在该次尝试结算时解析为确切 binding，包括 Remote failure 以 `openState: 'error'` 表示的情况。仅当 `Session.open()` 拒绝、等待方取消或引用提前释放时，`ready` 才拒绝。取消一个等待方不会取消其他 owner 的打开。`sessions.using(target, options, operation)` 等待该次结算，持有引用直到回调结束，并传播被拒绝的就绪与回调失败。

引用保活本地会话数据、作用域 Context 和历史流，不保活 Host Agent。最后一个引用释放时，generation 先退出可访问映射，再执行清理；后续获取可以为同一 id 创建新 generation。`binding(id)` 和 `scope(id)` 只借用已有 generation。`retainInfo(id)` 独立于目录成员关系观察稳定的只读来源计数，不执行历史 I/O。消费方来源键可通过声明合并扩展；导航和完成确认属于 UI 消费方，不属于本控制器。所有权与清理规则见 [Client 会话引用](../../../.agents/notes/implemented/architecture/2026-09-15-client-session-references.zh.md)。

<a id="session-media-references"></a>
## 会话媒体引用

当 `connection`、`fs` 与 `attachments` 均被组合时，`SessionMediaReferences` 在鉴权 `connection.fetch` 通道上挂载 `GET|HEAD /api/file?path=<绝对路径>`。它通过 `ctx.fs` 读取普通文件，包括已注册工作区之外的临时路径与远程提供方中的文件。目录包含关系与 MIME 类别均不限制访问；`mime-types` 提供响应类型，未知扩展名使用 `application/octet-stream`。GET 复用 `readBytes` 执行读取前及读取中的字节限制；HEAD 只读取元数据。所有文件均使用 `ctx.attachments.imageLimits.maxImageBytes`（通常为 20 MiB）；超过此上限返回 413。响应包含完整文件，忽略 Range，并携带 `private, no-store`、`nosniff` 与沙箱 CSP，使直接打开的 HTML/SVG 无法以 API 源身份执行脚本。客户端重写位于 `ui-chat`（`AssistantMarkdown`）；音视频文件响应已可用，Markdown 音视频播放器节点仍是独立工作。

-----

<a id="configuration"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `nativeOpen` | 平台探测 | 是否能把 Session 工作区路径交给原生桌面打开器 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-session-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
首次 `captureCollaborationSource` 返回 Host 专用 `analyze(persist, signal)`，绑定原始快照及一次性已准备调用。恢复的 Source 不提供新调用或分析。`CollaborationAnalysisManifest` 包含 `prompt_version`、原始 `source` 及不含 signal 的完整 `request`；Host 所有的 `persist` 回调必须先持久提交全部 attempt 输入才可返回。Profile 在该提交前后重验原会话归属。`CollaborationAnalysisResult.jsonText` 是供持久协调器校验的不可信 JSON，不授予受理或 Source 权限。

分析仅使用含原文和显式 mention 元数据的一条 user 消息及分析提示词，工具为空，不携带普通历史。每个 Profile 最多允许两个尚未清理的调用，等待上限 30 秒；取消后仍不响应的操作保留并发位置直到清理完成。输入采用保守的 16 KiB UTF-8 请求预算，输出限制为提供方 8192 token 和累计流文本 32 KiB；超限拒绝，不截断。纯中间件回复、工具输出、非成功终止结果及非法 JSON 均拒绝。这里不执行模型修复、重试或重启后的可执行恢复；云端 attempt 租约、候选受理及实际聊天调用方仍由协调器负责。

## 模型体验

普通命令的模型输入由其 Agent 所有。Host 专用 Source 分析通过捕获的模型发送单独持久化的原文、mention 元数据及分析提示词，不启动 Agent turn。

#### KV Cache 影响

无直接影响；模型请求仍由 Agent 和 LLM（大语言模型）包拥有。

`inspectCollaborationSource(target, signal)` 通过所属 Profile 的注册表与 journal 读取原始持久 Source，仅返回原坐标及完整 RFC 8785 快照的 SHA-256，摘要包含首次 journal 提交标识。记录不存在、归属丢失、附加元数据、取消和 Profile 销毁都会拒绝。读取与已接受的捕获串行执行，不准备模型或恢复调用；延迟打开的 journal 由 Profile 持有至销毁。私有 worker HTTP 读取器调用这一仅供 Host 使用的方法。

`readCollaborationSourceSnapshot(target, signal)` 使用相同 Profile 归属、串行 journal 读取与取消检查，返回独立冻结的原始快照。`inspectCollaborationSource` 从该读取结果生成描述符。私有 worker 通过 `parseCollaborationSourceSnapshot` 校验 journal 内容；不新增 Remote 导出、模型准备、Session 事件或可执行调用恢复。

<a id="collaboration-analysis-journal"></a>
`openCollaborationAnalysisJournal(facility)` 拥有独立的单文件 `collaboration_analysis_v2` 领域。`createCollaborationAnalysisWriter(journal, claim)` 提供 Source 分析所需的 persist 回调：先提交完整、无信号 manifest 的规范 JSON，再向当前可信协调器申请派发资格，匹配的资格记录持久化后才返回。`CollaborationAnalysisJournalRecord` 保留原始请求 ID、完整 Source digest 与输入 manifest digest；`CollaborationAnalysisDispatchGrant` 绑定 plan/revision/attempt/fence 和租约。重复请求、取消、过期资格和写入确认丢失都会阻止派发。恢复只能枚举冻结的输入与资格记录，不恢复可执行调用。Profile 在已接受写入排空后关闭 `CollaborationAnalysisJournal`。回调中的协调器权限以及真实聊天/传输装配仍由调用方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 图片字节上限不校验解码后的尺寸或像素数。
- Control baseline 表示进程本地状态，因此 Host 重启后无法重建 jobs。
- follow 恢复失败会对调用方可见，而不会无限重试。
- 浏览器原始字节上传使用一次不带断点续传偏移的流式 HTTP 请求；重试会从第零字节重新传输整个文件。
- 文件引用补全使用共享 Agent lookup，因此可能恢复冷 Session；`skills/list` 目录是不激活 Agent 的 skill 元数据读取路径。
- 协同 Source 捕获目前是 Host 库基础方法。聊天路由、云端 Source 授权、持久 route/outbox 状态转换与 Source 退休尚未挂载。恢复枚举不恢复可执行模型句柄，也不派发任务。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。每个分页与帧都会对照其指向的持久 Session 校验。

`CollaborationAnalysisJournal.saveOutput` 另将完整、不可信的模型 JSON 写入独立的单文件 `collaboration_analysis_output_v2` 领域，再向父 Host 返回分析成功。结果绑定原已消耗尝试、Source/输入摘要及原文输出摘要，不能替换已有文本。`outputs()` 仅供读取冻结记录进行对账。非法 JSON、超限结果、损坏关联和写入确认丢失都会拒绝使用，同时保留文件。打开和关闭 journal 管理两个领域；已有输入、Source 与 Session 格式保持独立。
