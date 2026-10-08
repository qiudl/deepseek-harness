---
description: "dsh 的浏览器 GUI：交互式聊天、模型与设置管理、会话历史，供运行 dsh web 表层的用户使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

[English](README.md) | 中文

桌面埋点遵循[产品采集策略](../../client/product-analytics/README.zh.md)及其动态应用配置，不包含 Web 使用情况。

桌面埋点每 30 秒调度未满批次，exporter 超时为 15 秒，processor 超时为 20 秒。退出时允许 2 秒排空，随后取消待完成的请求和重试等待，避免埋点阻止 Host 退出。尚未发送完成的事件可能丢失。

## 概述

运行 `dsh --profile web`，打开提供聊天、模型与设置管理以及会话历史的交互式浏览器 GUI。它使用与其他 dsh 表层相同的模型访问、工具与安全默认值。启动时会打印带认证信息的 URL，通常还会在默认浏览器中打开；SSH 会话和 `--no-open` 会保留该 URL，供你手动打开。你可以更改端口并允许额外主机，但不能绑定所有网络接口。需要在浏览器中交互式工作时选择本包；一次性的命令行任务应使用 `dsh-headless`。


## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>

## 使用本包

启动 GUI、打开浏览器，然后开始与 agent（智能体）对话。flag 用于微调本次调用。

### 启动 Web GUI

```sh
dsh --profile web
dsh --profile web --no-open --port 8080
```

启动后你会看到 `dsh web:` 行，其根 URL 携带新的进程 token。除非 `--no-open` 或 SSH 会话抑制，否则默认浏览器会打开该 URL、取得签名 cookie，再重定向到不含认证参数的同一目录。页面加载且你可以与 agent 对话，就说明成功了。两种可预期的失败：前端未构建时，启动会以构建提示停止（checkout 中运行 `pnpm run build`）；浏览器无法打开时，stderr 会打印不含凭据的诊断，但服务器会继续运行——请自行打开已打印的启动 URL。

**设置 → 模型**显示 **DeepSeek**，使用 `DEEPSEEK_API_KEY`。默认模型为 `deepseek-official` / `deepseek-flash`（DeepSeek-V41-Flash）。[DeepSeek 插件](../../llm/llm-deepseek/README.zh.md#endpoint-and-wire-format)使用 Messages API。

已保存的模型选择覆盖组合默认值。设置卡接受兼容 Messages 的 API 地址与凭据引用。

### 配置

大多数用户不需要设置这些；命令行 flag 会提供给下面四个设置——`--host`、`--port` 与 `--trusted-host` 来自本次调用，`--no-open` 仅对本次调用关闭浏览器交接：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `openBrowser` | `true` | 启动后用默认浏览器打开；SSH 启动会抑制它 |
| `printUrl` | `true` | 启动时打印 `dsh web:` URL 行 |
| `surfaceContext` | `true` | 给 agent 提供 GUI 定位上下文，并把 `DSH_WEB_URL` 暴露给其 shell 命令 |
| `trustedHosts` | `[]` | 允许从网络访问 GUI 的额外主机 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)是每个受支持字段及其 JSDoc 的穷尽式真源。 随发行版交付的组合不含 `time-context`、`schedule` 和 `ui-schedule` 行，可选实验性 bundle `@deepseek-ai/dsh-experimental-schedule-bundle` 可在插件管理页插入这三行。

### LAN 访问与可信主机

默认情况下 GUI 只接受本机的连接。绑定所有网络接口的部署也会允许 LAN 内的浏览器访问，此时打印的 URL 会附带一个 LAN 地址；`--trusted-host` 在两种情况下都能添加额外主机。Host 与 Origin 检查控制可达性，token 交换则认证每个 Host API 方法与 WebSocket 流。LAN 地址只在启动时采样一次，因此之后的网络变化不会被感知——重启 GUI 以重新公告。

### 通过 SSH 运行

通过 SSH 启动 `dsh --profile web` 时，URL 行仍会打印，但不会为你打开浏览器：本地转发地址由 SSH 客户端或编辑器持有。请在自己的机器上打开转发后的 URL；打印出的 URL 指向远端宿主机 loopback 端点。

### 按会话的 agent 设置

每个浏览器会话选择一个随发行版交付的 preset（默认 `standard`）。Agent 预设设置页可更改默认项并编辑预设的子插件；保存结果持久化到 `$DSH_HOME/profiles/web/cordis.patch.yml`。只有 Host 提供可编辑的 profile 时，Creator 的插件管理工具才会启用。

-----

<a id="understand-the-implementation"></a>

## 理解实现

`DSH_PROFILE_WORKSPACE_MODEL_TOKEN` 仅在隔离 Profile worker 中启用 `/internal/desktop-workspace-model-selection`。入口接受最多 2 KiB 的注册表工作区/Session 目标，交给仅供 Host 使用的 Session Controller 读取，不激活 Agent 或调用模型。浏览器 Cookie 不能授权此入口。失败不含异常详情；响应禁止缓存，仅包含已校验的选择字段。该读取不提供 Source 凭据或已准备的配置快照。

隔离的 Desktop Profile worker 提供 `DSH_PROFILE_MODEL_TOKEN` 时，本包还提供仅供 Host 使用的本机文本请求。它读取 Profile 当前默认模型，并用该 Profile 的凭据服务处理一条用户消息，不启用工具，也不创建 Session。私有令牌不返回浏览器；请求最多 8 KiB，回答最多 16 KiB，执行最多 60 秒。另一条使用令牌认证的本机路由通过 Profile 现有的 Session Remote 方法执行有界 Desktop Session 命令；浏览器 Cookie 不能授权此路由。会话历史只投影 Web 可见的消息、工具和回合字段，并按 Host 控制帧预算返回近期且顺序不变的记录后缀；内部、更早或过大的记录会被省略。第三条仅供 Host 使用的路由由 `DSH_PROFILE_REMOTE_UI_TOKEN` 启用，通过现有 Gateway 接受精确的 Session 和启动读取，请求与响应均有上限。启动读取包括脱敏设置、预设清单、无源码的插件清单、无密钥值的凭据状态和权限选项；凭据引用有数量及格式校验。`dynamicCordisRunner/syncInspectManifest` 会修改 Host 状态，因此仍被拒绝。启动读取只返回当前结构化注入项，不提供任意 URL 内容；浏览器父页面仍须在执行远程脚本前认证并校验资源字节。 Session follow 会在校验两个正安全整数下限和消息上限后转发原生 `turnWindow`。同一私有令牌还保护独立的 `session/follow`、`workspace/follow` 或 `$events` NDJSON 路由；单条事件上限为 512 KiB，Host HTTP 读取端断开时会取消 Gateway 迭代器。浏览器 Cookie 不能授权这两条远程 UI 路由。这些只是内部构件，不是浏览器公共 API 或完整远程传输；事件流与写操作仍需单独的 Host 租约授权桥接。 `session/collaborationSources` 读取所属 Session 的已有 journal，不准备模型或提交任务。远程控制读取每页返回一条完整原消息，JSON 最多60 KiB，以其不可变快照摘要继续分页；单条更大的消息被拒绝，不截断正文。Session Controller 为本地 Client 保留普通的每页八条消息、256 KiB 列表。

Desktop 远端 Session 路由启用时，选定 Profile 为每个 Session 保留一份控制权证明。未受控制的 Session 接受本地浏览器写入时会隐式认领；远端控制者通过显式认领和比较交换接管。Profile 对支持的每次修改及审批答复核对远端证明，在 Gateway 检查本地浏览器写入和事件答复，并持有已获准的写入直到执行结束。控制权在未续期 30 秒后过期，Profile 重启也会使旧证明失效。daemon 和 Slark Server 必须交换 Profile 证明，远端浏览器才能使用这些命令。

远端客户端持有当前 Session 控制权时，Desktop 浏览器会在会话标题栏显示接管入口。用户点击后，浏览器重新读取 Profile 当前 epoch，请用户确认，再通过已认证的浏览器 Gateway 提交比较交换接管。用户随后重新发送保留的草稿。Desktop 远端 Session 路由未启用时不显示此入口。

远程 `session.create` 向选定 Profile 转发可选的工作区和会话 ID。Profile 通过本机注册表和原生 Session controller 解析这些 ID；调用方指定的路径不能通过 Host 命令协议。原生 `session/writer-held` 拒绝返回有界的 `sessionCreateFailure` 值，供远程 UI 执行已有的空白会话回退规则。原生审批答复使用仍在等待的 `$events` 连接，且必须匹配其 Session ID。事件流会拒绝第二个 ready 帧或已被其他活动事件流占用的客户端 ID；事件流关闭时清除待处理审批。

<details>
<summary>实现细节——点击展开</summary>

此 bundle 由一层五个文件的补丁和一个运行时胶水插件组成：`cordis.patch.yml` 承载宿主行和 preset 注册表，每个 `presets/<id>.patch.yml` 插入一条随发行版交付的 preset 声明，按 `dsh.bundle.patch` 列出的顺序应用。存储栈与投影缓存来自 `dsh-base`；Web 叠加层的工作区和消息反馈条目消费共享的 `storageDomain` 服务。补丁重述 base 有意省略的界面专用值，插入 Web 专用宿主条目和浏览器插件列表，再将 Agent 层移到预设后面。胶水插件负责 dist 服务、信任采样、提示词段落、bash 变量和就绪通知。`office-to-pdf` 条目为宿主消费者挂载一个延迟创建引擎的 [Office 转换提供方](../../document/office-to-pdf/README.zh.md)，使用此 bundle 的 Desktop 组合也共享该提供方。 转换服务的 Remote 方法负责预览读取授权，Document Preview 负责 Office 查看器和客户端缓存。

### patch 语义

patch 会替换目标行的整个 `config`，因此每个 Web 行都重述自己拥有的每个键：基础行上的 persona 前缀与后缀模板、`DSH_TOOLS_MODE` PTC mode 开关与 `session-query-sqlite` 值，随后 `insert` 添加 Web 宿主行、传输层与浏览器名录。base 以进程级挂载的按 agent 工具行在这里被禁用，由 preset 名录接管；每项宿主层与 preset 层归属决策的理由以行内注释写在 patch 里。

### 就绪宣告

URL 行与浏览器交接都是就绪信号：监督方一观察到该行就发起 RPC，浏览器一打开就请求页面，因此两者只在 Loader 配置树结算、通过 required 启动检查且 Connection 认证可用后运行——在没有 Loader 的手工构建树中则立即运行。此时 client combo JavaScript 和 source map 仍未物化。可选插件失败不会阻止就绪宣告；required 启动失败或启动中途被释放的树不会宣告任何内容。

### LAN 信任采样

`resolveLanTrust` 在启动时只采样一次网络：loopback 绑定（`127.0.0.1`）不派生任何 LAN 地址，绑定所有网卡则会加入每个非 internal IPv4 字面量。派生字面量加上显式的 `--trusted-host` 权威标识组成 `/api` 浏览器信任栅栏，打印的 LAN URL 始终与该栅栏一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `web-app` 粘合插件：dist 解析、LAN 信任采样、提示词段落、bash 变量、URL 行、浏览器交接 |
| [`src/startup.ts`](src/startup.ts) | `web-startup` 提供方：`--host`、`--port`、`--trusted-host`、`--no-open`、`--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | Web patch：重述的基础值、Web 宿主行、浏览器名录、preset 注册表 |
| [`presets/`](presets) | 每个随发行版交付的 preset（`standard`、`ptc`、`minimal`、`cordis`）各一条 `@deepseek-ai/dsh-agent-preset` 声明，各自一个补丁文件 |
| — | 不发布运行时不变式伴生入口；每项贡献（frontend-static 子插件、提示词段落、bashEnv 注册）都会随 fiber 由注册表释放，且每个所属注册表的包负责该关系的不变式；本包不持有需要审计的可变状态。 |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | dist 解析、回退席位、提示词段落、就绪宣告 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |
| [`tests/trusted-hosts.spec.ts`](tests/trusted-hosts.spec.ts) | LAN 信任采样 |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | 页面可达后的默认浏览器交接 |

### 不变式归属

不发布不变式伴生入口，因为每项贡献——frontend-static 子插件、提示词段落与 bash 变量注册——都会随 fiber 由注册表释放，且每个所属注册表的包负责该关系的不变式。

</details>

-----

<a id="further-exploration"></a>

## 进一步探索

当你想深入了解共享核心、浏览器重载流水线或已构建的前端时，阅读以下页面。

- [组合包索引](../README.zh.md)——基于同一核心构建的表层。
- [dsh-base](../base/README.zh.md)——GUI 运行其上的共享核心。
- [dsh-client-hmr](../../client/hmr/README.zh.md)——开发期间客户端插件变更如何重载。
- [frontend-static](../../host/frontend-static/README.zh.md)——已构建的前端如何被服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>

`DSH_PROFILE_SOURCE_TOKEN` 在隔离 Profile worker 中启用 `/internal/desktop-collaboration-source`。私有 POST 接受最多 2 KiB 的精确原始 Source 坐标，返回已有 journal 记录的已校验描述符。浏览器 Cookie、调用方模型或提交字段、缺失 Source 和丢失的 Session 归属都会被拒绝。响应禁止缓存、隐藏异常详情，不含消息正文或可执行调用；签名由父 Native Host 负责。

同一私有令牌另启用 `/internal/desktop-collaboration-source-snapshot`。精确坐标定位所属 Profile 的已有 journal 快照，并严格校验嵌套元数据及内容摘要。响应为描述符与原始 Source JSON，不含凭据或可执行句柄。浏览器 Cookie 不授予路由访问权；归属缺失、journal 损坏和读取失败均返回隐藏详情的拒绝。父 Host 读取完整有界响应，再经固定控制协议分块传输。

独立的 `DSH_PROFILE_REFERENCE_TOKEN` 启用 `/internal/desktop-collaboration-reference-capture`。父 Host 发送最多 32 KiB 的已授权定位、范围与接收对象选择。原文引用要求 Profile 返回确定的 UTF-16 范围，以及与引用文本精确匹配的字节长度和摘要。Session Controller 从实际内容独立生成并持久保存完整请求；响应只含最多 32 KiB 的计算元数据，不返回内容字节。Source 读取令牌和浏览器 cookie 不能捕获引用。可信父 Host 必须在调用前确认用户明确分享意图；自然语言定位和云端传递仍须独立接入。

同一个独立 Reference token 保护 `/internal/desktop-collaboration-reference-content`。私有查询最多 2 KiB，仅含原始 Source 坐标、已提交的完整引用请求摘要和字节偏移。Profile 在每次响应前重新核验当前成员关系和选中内容。响应包含最多 32 KiB 的精确分块，支持空内容且禁止缓存；Source token 和浏览器 cookie 均无读取权限。云端传递和任务附件仍由协调器负责。

同一个 Source token 保护 `/internal/desktop-collaboration-reference-grant`。私有查询限制为 2 KiB，只包含原始 Source 坐标及完整引用请求摘要。所属 Session Controller 要求独立提交的选择，并重新核验当前消息或附件字节。脱敏且不可缓存的响应只包含 Source 描述符与匹配摘要；浏览器 cookie、调用方路径或内容均不能授权此读取。

### 远端工作区目录

远端目录选择器在 Host 的屏幕上运行。选定目录获得绑定配对客户端的 Profile 内确认；`workspace.create` 在60秒内一次消费此确认，拒绝其他路径或客户端。取消不生成确认，选择器确认不会写入日志。Host 仅在安装 worker 命令执行器后公布 `profile.remote_session.directory_picker`。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到什么

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（first-party 顺序 10100，位于可复用指令之后）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

源码与 Web 段落位于第一方可复用指令之后。工具与配置一致时，不同 checkout 路径或本地端口不会改变前置前缀；不保证提供方复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制告诉你在不常见的环境下会遇到什么——源码 checkout、SSH 会话或严格网络。它们是当前包约束，不是通用的浏览器对比或任务积压。

- **前端必须已构建**——源码 checkout 需要先运行 `pnpm run build`；dist 缺失时启动会以构建提示停止，且没有从源码直接服务的回退路径。
- **LAN 地址只在启动时采样一次**——启动后的网卡变化不会重新公告；打印的 LAN URL 始终与采样结果一致。
- **只能观察到交接的启动**——GUI 只报告浏览器被请求打开，而不是它确实打开了；之后的浏览器退出永远不会上报，打印的 URL 是你的手动回退路径。
- **SSH 会话保留 URL 但跳过浏览器交接**——打印的 URL 指向远端宿主机 loopback 端点；SSH 客户端或编辑器必须暴露并打开本地转发地址。
- **`BROWSER` 覆盖只能来自环境**——被发现的 `.env` 不能设置 `BROWSER`；只有继承值能为自动交接选择可执行文件。
- **不支持绑定所有网络接口**——出于安全考虑，`--host 0.0.0.0` 会在启动时被拒绝；请使用默认 loopback 主机。
- **Desktop 控制权把本地浏览器窗口视为同一方**——Profile 当前将本地浏览器窗口归为一个 Desktop 控制者。证明覆盖 Session Remote 修改与转发的审批答复；终端输入、文件上传和设置写入由其他模块负责，不在此证明范围内。


<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

`DSH_PROFILE_ANALYSIS_TOKEN` 单独为父 Host 启用 `/internal/desktop-collaboration-analysis`。`prepare` 捕获所属 Profile 的 Source 并保存完整分析输入，等待云端资格而不调用模型。`dispatch` 仅在原归属摘要下继续同一个一次性调用，先持久保存结果再响应。最多两个待完成操作，准备和执行分别限时 30 秒；云端受理仍使用原租约，本地输出保存证据而不授予受理权限；取消、销毁、过期资格和重复请求均拒绝继续。浏览器 Cookie 和 Source 读取令牌不能授权此入口。该私有路由不授予任务受理资格，不提供可执行恢复或 Renderer API。

`capture_reply` 先保存不含新增 active mention 的补充 Source，仅保留进程内调用，不开始分析。协调器提交补充消息与选定待澄清项的关联后，`prepare_clarification` 由所属 Profile 核验完整原文及补充输入，保存新 manifest，再等待匹配计划及修订号的资格。分析身份仍为原始 Source 描述符。重复捕获仅返回不可执行恢复；并发准备、归属变化、过期与销毁均不能重建或重复派发调用。这些操作共用两个进行中操作的上限，准备和执行分别限时 30 秒。

Web 组合包含账号 Remote 控制器和账号设置页面。

`DSH_PROFILE_DELIVERY_TOKEN` 独立为父 Host 启用 `/internal/desktop-collaboration-delivery`。入口接受最多 1 MiB 的精确可读投递 JSON，由所属 Session Controller 校验原 Source 与当前归属。完整回复保存后才返回禁止缓存的首次提交描述符，不回传答案。浏览器 Cookie、Source 读取令牌、调用方提交字段及受限投影不能授权保存。取消、写入失败和提交后的归属丢失均不返回成功回执，也不删除已保存的数据。此路由不签发云端确认，不追加聊天事件。


私有 `/internal/desktop-collaboration-root` 端点复用仅父进程持有的 Source 能力，通过 `inspectCollaborationRoot` 读取持久根元数据。它只接受精确的 namespace、命令及原始来源坐标，拒绝浏览器 cookie 和绑定不符的响应，不返回来源正文或可执行 handle。路由释放时移除处理器。

私有端点 `/internal/desktop-root-journal` 要求 `DSH_PROFILE_ANALYSIS_TOKEN`，只接收不超过 2 KiB、字段严格匹配的 read/accept JSON，并返回不含 Source 正文的根元数据。浏览器 cookie 和 `DSH_PROFILE_SOURCE_TOKEN` 均不授予访问权限。Session Controller 校验归属并持久化完整原回执后才返回成功；两种操作都不会重新捕获 Source 或准备模型。

`prepare_root` 调用 `captureCollaborationRoot`，由同一个两阶段 owner 保留首次分析调用；根持久化后才确认准备完成。回复同时包含原根描述与 prepared 或 recovered Source 元数据；恢复结果不包含可执行尝试。根准备同样遵循原绑定、超时、取消和单次派发规则。根登记或规划候选保存均不授予任务执行权限。

`read_root_output` 经当前 Session/Workspace 归属校验读取已受理根，再将保存输出与原始持久派发记录关联；读取后再次校验根归属。输出缺失会明确返回；记录歧义、根变化、取消或释放都会拒绝。重新打开日志仍保留原输出与派发凭据，不准备或调用模型。云端消费者提交候选前仍须独立执行原租约与栅栏校验。

`recover_root` 按 namespace 与 Source 坐标读取已有 admitted 根，要求原正文、mentions 和续接策略一致。它不捕获 Source、不准备模型、不写根，也不创建派发状态。pending 或不存在的根、输入变化、取消及归属丢失都会拒绝；本地受理回执缺失须另行对账。

`reconcile_root` 还可读取 pending 根，供 Main 查询原始云端回执；它执行相同的 Source、策略和归属校验，不受理根，也不准备模型。

`resume_root` 要求根已 admitted，且原始准备仍在相同 Account/Host 绑定下存活。重连可通过 Parent 派生的 Account/Profile/Host 进程身份交接，旧连接随即失去派发权。仅在派发尚未使用时返回相同 attempt 与 manifest；不准备新的模型调用，不延长30秒期限。进程重启、超时、归属丢失或派发已消费时拒绝。

analysis token 端点管理 `prepare_root_attempt`、`inspect_root_attempt` 和 `dispatch_root_attempt`。`DesktopRootPlanning` 从旧分析 journal 或当前新尝试链确定前驱；已知派发记录或仍存活的原准备会阻止新准备。最多保留两个待处理根，准备和执行分别限时 30 秒；同连接重试保持身份和截止时间。完整输入持久化后才发布元数据，签名观察与派发前重新核验归属、当前 journal 状态，以及父 Host 推导的 Account/Profile/Host/连接绑定。worker 重启不恢复可执行句柄：重新准备未使用输入会产生新尝试，并保留前驱关系。输出保存在已消费 grant 旁，销毁等待进行中工作和 journal 写入结束。云端可替代性和 grant 认证仍由父协调方负责。

analysis-token 的 `read_root_attempt` 操作在 owner 重建后读取最新持久尝试及校验过的已保存输出，不准备模型。它在存储读取前后检查原根归属，取消或 owner 关闭后丢弃结果。过期授权仍作为已消费历史可见；派发必须另有当前云端授权。

analysis-token 的 `root_execution_journal` 操作将精确的 read/prepare/accept 请求交给所属 Session Controller。它保留 Profile 生命周期取消约束，拒绝仅浏览器授权及未知字段，仅返回持久化记录或明确的 null 读取结果，不准备模型、不向云端派发。

分析令牌保护的 `root_feedback` 操作将私有读取或入队命令交给 Session Controller，并保留取消和精确字段校验。响应只包含有界的持久化观察记录，不含结果正文。浏览器 Cookie 不能授权消费，该操作也不激活模型。

同一私有 `root_feedback` 通道也将 `consumer_prepare`、`consumer_start` 与 `consumer_read` 交给持久消费 owner。只有当前首次授权可唤醒原 Agent；start 请求的取消生命周期持续到 Agent 结算。历史读取不会恢复唤醒句柄。浏览器结果控件只经已认证 Desktop Main 提交保留的预览、任务及投递身份。

私有反馈通道还将 `continuation_read` 路由到原 Session Controller。它返回尚无已提交观察或不可变的首条回复坐标；重复读取保持原 trace，不会启动新的模型请求。
