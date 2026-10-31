---
description: "dsh 的浏览器 GUI：交互式聊天、模型与设置管理、会话历史，供运行 dsh web 表层的用户使用。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

[English](README.md) | 中文

桌面埋点遵循[产品采集策略](../../client/product-analytics/README.zh.md)及其动态应用配置，不包含 Web 使用情况。

桌面埋点每 30 秒调度未满批次，exporter 超时为 15 秒，processor 超时为 20 秒。退出时允许 2 秒排空，随后取消待完成的请求和重试等待，避免埋点阻止 Host 退出。尚未发送完成的事件可能丢失。

## 概述

运行 `dsh --profile web`，获得浏览器内的聊天、模型与设置管理以及会话历史，并与其他 dsh 表层共用同一套模型访问、工具与安全默认值。启动时会打印带 token 的 URL，通常还会在默认浏览器中打开；SSH 会话和 `--no-open` 需要手动打开。你可以更改端口、允许额外 authority、绑定一个具体的本机 IP，并用自己提供的证书直接提供 HTTPS；通配地址会被拒绝。跨机访问使用剥离前缀代理后公告的 HTTP(S) URL、监听器 TLS，或非 loopback 绑定上的明文 HTTP。一次性的命令行任务应使用 headless 配置。


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

**设置 → 模型**显示 **DeepSeek**，使用 `DEEPSEEK_API_KEY`。默认模型为 `deepseek-official` / `deepseek-flash`（DeepSeek-V4.1-Flash）。[DeepSeek 插件](../../llm/llm-deepseek/README.zh.md#endpoint-and-wire-format)使用 Messages API。

已保存的模型选择覆盖组合默认值。设置卡接受兼容 Messages 的 API 地址与凭据引用。

### 配置

`--host` 与 `--port` 配置监听器；`--tls-cert` 与 `--tls-key` 让它直接提供 HTTPS；`--public-url` 指定 GUI 在剥离前缀的代理之后对外公告的公开 HTTP(S) 根，`--trusted-host` 则添加更多被接受的 authority。这些都在[监听、信任与公开部署](#public-deployments)中说明，而这些 flag 设置的 `tls` 字段记录在[载体的配置](../../../docs/subsystems/web-server.zh.md#config)中：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `openBrowser` | `true` | 启动后用默认浏览器打开；SSH 启动会抑制它 |
| `printUrl` | `true` | 启动时打印 `dsh web:` URL 行 |
| `surfaceContext` | `true` | 给 agent 提供 GUI 定位上下文，并把 `DSH_WEB_URL` 暴露给其 shell 命令 |
| `publicUrl` | 未设置 | 对外公告的 HTTP(S) 应用根；否则公告绑定地址 URL |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)列出了本运行时插件接受的字段及其 JSDoc。随发行版交付的组合插入 `schedule` 服务行与 `ui-schedule` 任务页面行，时钟读数与四个提醒工具则属于 `standard`、`cordis` 与 `ptc` 三个 preset。这三个 preset 的 `tool-subagent` 与 `tool-subagent-fork` 两行都 deny 这四个工具，因此被委派子 agent 的作用域不会列出它们。

<a id="public-deployments"></a>
### 监听、信任与公开部署

默认情况下 GUI 只监听 loopback，只接受本机的连接。只有 `--host` 会改变监听器：它接受一个具体的本机 IPv4 或 IPv6 地址，不接受通配地址。未启用 TLS 的非 loopback 监听器提供明文 HTTP，并在启动时警告，即使前置 HTTPS 的 `--public-url` 也不例外。Host/Origin 栅栏接受绑定 IP 本身；其他非 loopback authority 需要 `--trusted-host`，因此远端浏览器要么经由剥离前缀的代理访问 GUI，要么通过以可信主机名呈现的端口转发客户端访问。启动 token 交换与签名会话 cookie 认证每个 API 方法与 WebSocket 流。

同时传入 `--tls-cert` 与 `--tls-key`，监听器便以 HTTPS 而非明文 HTTP 提供服务。两者各指定一个相对进程工作目录解析的文件：证书文件包含完整证书链，密钥文件为不带口令的 PEM 私钥。它们属于同一个设置——只提供一个会报用法错误，两个都不提供则保持明文 HTTP 默认值。文件缺失、不可读、为空，或不是有效的证书与密钥对时启动失败；绝不回退到 HTTP。监听器运行期间不会重新读取这些材料，因此更换证书需要重新加载监听器或重启进程。DSH 不签发、不续期也不监视任何证书：没有 ACME 客户端、没有自签名兜底，也没有重定向监听器。浏览器使用自己的信任库与主机名匹配，因此浏览器不信任的证书，或其 subject alternative name 未覆盖你所访问 authority 的证书，会在页面加载前失败。默认端口仍为 3080，且 `--tls-cert`/`--tls-key` 不跟随 `--public-url`：监听器的证书覆盖浏览器实际访问的 authority。TLS 不改变授权模型：Connection 仍认证每个请求并仍校验 Host/Origin，且只要接收请求的监听器提供 HTTPS，它所签发的会话 cookie 就带 `Secure`。

容器可以绑定其 Pod 地址，并公告前置的 ingress：

```sh
dsh --profile web --no-open --host "$(hostname -i | awk '{print $1}')" --public-url https://app.example/ --trusted-host app.example
```

`hostname -i` 可能列出多个地址；`--host` 只接受一个，因此命令取第一个。`fe80::1%eth0` 这样的 zone ID 不能出现在 URL 中，因此公告根会剥离多余的 loopback zone，而非 loopback zone 则要求显式提供 `--public-url`。

未设置 `--public-url` 时，`::ffff:127.0.0.1` 这样的 mapped IPv6 回环绑定会公告其 IPv4 形式 `127.0.0.1`，让浏览器将其识别为本地可信来源。监听器仍使用配置的绑定地址。点分四段式的 IPv6 尾部表示该地址自身的低 32 位，与 `listen` 的读法完全一致：`::0.0.0.1` 属于 IPv6 回环并公告 `[::1]`，而 `::127.0.0.1` 是非回环地址，并非 IPv4 回环。

`--public-url` 公告浏览器使用的 HTTP(S) 根——打印与打开的启动 URL、`DSH_WEB_URL` 与 web 表层定位。公告不授予任何信任：浏览器可见的 authority 还必须用 `--trusted-host` 点名。该 flag 不配置监听器、路由或 cookie 作用域，因为外部链路归代理所有：[在反向代理之后发布 Web UI](../../../docs/user/guide/public-deployments.zh.md)列出了这样的部署必须提供什么。

无论是公告 URL 还是浏览器信任栅栏都不保护端口本身，因此请把端口限制在可信代理或网络内。

打印的 URL 包含进程凭据，只应与预期用户分享。`printUrl: false` 无论是否配置 `--public-url` 都会抑制该行，凭据也绝不会出现在模型上下文或 `DSH_WEB_URL` 中。

### 通过 SSH 运行

通过 SSH 启动 `dsh --profile web` 时，URL 行仍会打印，但不会为你打开浏览器：本地转发地址由 SSH 客户端或编辑器持有。没有公告根时，打印的 URL 指向远端宿主机的绑定地址端点——绑定 loopback 时即 loopback——你通过自己的转发地址访问它。配置了 `--public-url` 时，打印的 URL 是带认证的公告根；浏览器交接仍被抑制，因为在远端宿主机上打开浏览器无法到达你的屏幕。

### 按会话的 agent 设置

每个浏览器会话选择一个随发行版交付的 preset（默认 `standard`）。Agent 预设设置页可更改默认项并编辑预设的子插件；保存结果持久化到 `$DSH_HOME/profiles/web/cordis.patch.yml`。只有 Host 提供可编辑的 profile 时，Creator 的插件管理工具才会启用。

-----

<a id="understand-the-implementation"></a>

## 理解实现

`DSH_PROFILE_WORKSPACE_MODEL_TOKEN` 仅在隔离 Profile worker 中启用 `/internal/desktop-workspace-model-selection`。入口接受最多 2 KiB 的注册表工作区/Session 目标，交给仅供 Host 使用的 Session Controller 读取，不激活 Agent 或调用模型。浏览器 Cookie 不能授权此入口。失败不含异常详情；响应禁止缓存，仅包含已校验的选择字段。该读取不提供 Source 凭据或已准备的配置快照。

`DSH_PROFILE_SOURCE_TOKEN` 也保护 `/internal/desktop-bot-identity`。入口在每次请求时通过 Profile 本地可选的 `dsBotSlarkExternalGroup` 服务解析准确 Bot ID。服务或 Bot 缺失时返回缺失；只有 Bot ID、派生的发言者引用和有界显示名可以离开 worker。浏览器 Cookie 不能调用此入口。

`/internal/desktop-native-room` 使用同一 worker token 接收单个房间 ID，并调用 Profile 本地可选的 `dsBotSlarkNativeRoom` 服务准备 Slark 桥接 Source。响应只包含房间 ID 和 Source 坐标；房间 Session 自身的 Source 或附带额外字段的响应会被拒绝。浏览器 Cookie 不能调用此入口。

`/internal/desktop-native-room-operations` 使用同一私有 worker token 调用该服务有界的加入、消息分页、确认与离开操作。入口校验命令及响应的准确字段，每页最多返回三条消息。浏览器 Cookie 不能授权此入口。

`/internal/desktop-native-room-operations` 还只通过 Host 专用的 `profile.native_agent_result` 能力接收有界的 `agent-result-chunk`。Host 在转发给 Profile 前检查当前 Account、Slark 签名结果票据及仍有效的 Slark 轮次。Profile 按轮次组装完整回复、验证摘要、保存一条房间结果，并发布一条群 Session 消息。重复分块返回已保存的回执。

`DSH_PROFILE_ARCHIVE_TRANSITION_TOKEN` 单独启用仅供父 Host 调用的 `/internal/desktop-collaboration-archive-transition` POST。入口接受精确的账号、环境、工作区、Session、token 组合及一个有界阶段动作，再通过 Workspace Registry 串行化的持久写入执行。重复 `stage` 返回 token 的实际阶段。此入口不调用 Slark，也不授权浏览器归档请求；Main 或 Daemon 协调器必须按同一 token 对账不确定的写入结果。

同一仅供父 Host 使用的令牌还保护 `/internal/desktop-group-input-fence`。入口先校验精确的 Slark 群挑战，再由 Workspace Registry 串行持久写入；响应只回传已保存的 Workspace、Session、群 ID 和版本。结果不匹配时拒绝。浏览器 cookie 不能调用该入口，该入口也不激活云端群。

同一父 Host 专用 token 还保护 `/internal/desktop-collaboration-archive-intent`，按精确账号、环境、工作区和 Session 读取已有原 token 与阶段。Registry 拒绝归属不匹配，并在报告无意图前检查成员关系。浏览器 cookie 不能调用此查询。

隔离的 Desktop Profile worker 提供 `DSH_PROFILE_MODEL_TOKEN` 时，本包还提供仅供 Host 使用的本机文本请求。它读取 Profile 当前默认模型，并用该 Profile 的凭据服务处理一条用户消息，不启用工具，也不创建 Session。私有令牌不返回浏览器；请求最多 8 KiB，回答最多 16 KiB，执行最多 60 秒。另一条使用令牌认证的本机路由通过 Profile 现有的 Session Remote 方法执行有界 Desktop Session 命令；浏览器 Cookie 不能授权此路由。会话历史只投影 Web 可见的消息、工具和回合字段，并按 Host 控制帧预算返回近期且顺序不变的记录后缀；内部、更早或过大的记录会被省略。第三条仅供 Host 使用的路由由 `DSH_PROFILE_REMOTE_UI_TOKEN` 启用，通过现有 Gateway 接受精确的 Session 和启动读取，请求与响应均有上限。启动读取包括命令与技能列表、模型提供方、脱敏设置、预设清单、无源码的插件清单、无密钥值的凭据状态、权限选项和 `cotTranslation/limits`；凭据引用有数量及格式校验。`cotTranslation/limits` 要求空参数，只返回翻译偏好、可用提供方和文本上限，不授予翻译执行或设置写入操作。`dynamicCordisRunner/syncInspectManifest` 会修改 Host 状态，因此仍被拒绝。启动读取只返回当前结构化注入项，不提供任意 URL 内容；浏览器父页面仍须在执行远程脚本前认证并校验资源字节。 Session follow 会在校验两个正安全整数下限和消息上限后转发原生 `turnWindow`。同一私有令牌还保护独立的 `session/follow`、`workspace/follow` 或 `$events` NDJSON 路由；单条事件上限为 512 KiB；空闲时发送由 [Host 读取端](../../host/desktop-host/README.zh.md)消费的私有保活帧，读取端断开时取消保活定时器和 Gateway 迭代器。浏览器 Cookie 不能授权这两条远程 UI 路由。这些只是内部构件，不是浏览器公共 API 或完整远程传输；事件流与写操作仍需单独的 Host 租约授权桥接。 `session/collaborationSources` 读取所属 Session 的已有 journal，不准备模型或提交任务。远程控制读取每页返回一条完整原消息，JSON 最多60 KiB，以其不可变快照摘要继续分页；单条更大的消息被拒绝，不截断正文。Session Controller 为本地 Client 保留普通的每页八条消息、256 KiB 列表。 显式授权的 `session/follow` 私有请求可增加 `itemChunks: true`。它保留最多 8 MiB 的完整原生事件，压缩结果更小时采用压缩，并在 NDJSON 包装前以至多 10 KiB 字节的规范 base64url 分片输出。每片携带编码、字节偏移、压缩后总字节数与原字节长度；消费方必须校验并还原完整项。其他端点与未协商请求保留原事件限制。

私有 `bot/chat` 读取通过所选 Profile 显式启用的 Bot 服务，解析已有的默认或指定 Bot 及其当前私聊 Session。它不返回 Bot 配置、密钥或历史，也不执行 bootstrap 或发送。缺少提供者时返回 null；格式错误或目标被替换的响应会被拒绝。[Host 控制协议](../../host/control-protocol/README.zh.md)定义请求上限与 capability 协商。

私有 Session 桥还通过显式启用的 Bot 服务提供固定的发送与回执命令。发送持有预期 Session 的既有控制权；核对回执无需接管控制权。稳定 submission ID 跨网络请求与会话换段保留。Bot 提供者缺失时，两种命令均不退化为通用 Session prompt。响应离开 worker 前核对目标并验证；认证、取消和插件释放继续由既有层负责。

远程 `session/collaborationSources` 精确读取使用 `snapshotDigest` 替代 `cursor`，要求恰好一条匹配的原消息且无后续游标。摘要不符、定位与分页混用，以及单条消息超出预算时均拒绝；定位保留现有 Gateway 鉴权。

仅限 Host 的 `session/collaborationMembership` 读取校验最多 50 组准确的工作区与会话身份，调用当前 Profile 的 Session Controller，并在返回 Main 前验证数量、顺序及归属结果。浏览器 Cookie 不能授权这一私有 worker 路由。

Desktop 远端 Session 路由启用时，选定 Profile 为每个 Session 保留一份控制权证明。未受控制的 Session 接受本地浏览器写入时会隐式认领；远端控制者通过显式认领和比较交换接管。Profile 对支持的每次修改及审批答复核对远端证明，在 Gateway 检查本地浏览器写入和事件答复，并持有已获准的写入直到执行结束。控制权在未续期 30 秒后过期，Profile 重启也会使旧证明失效。daemon 和 Slark Server 必须交换 Profile 证明，远端浏览器才能使用这些命令。

原生移动端终端复用 Profile 现有的终端 Gateway。环境、Shell 选项和终端列表保持只读；创建、输入、调整大小、改名和关闭都要求当前 Session 控制权，Desktop 浏览器的对应终端写入也遵守同一控制权栅栏。follow 和 retain 先在控制权下取得十秒有效、一次性使用的票据；Profile 在打开原终端流及交付输出前再次校验控制者。关闭移动端流只释放 attachment，不关闭 Shell。

远端客户端持有当前 Session 控制权时，Desktop 浏览器会在会话标题栏显示接管入口。用户点击后，浏览器重新读取 Profile 当前 epoch，请用户确认，再通过已认证的浏览器 Gateway 提交比较交换接管。用户随后重新发送保留的草稿。Desktop 远端 Session 路由未启用时不显示此入口。

远程 `session.create` 向选定 Profile 转发可选的工作区和会话 ID。Profile 通过本机注册表和原生 Session controller 解析这些 ID；调用方指定的路径不能通过 Host 命令协议。原生 `session/writer-held` 拒绝返回有界的 `sessionCreateFailure` 值，供远程 UI 执行已有的空白会话回退规则。原生审批答复使用仍在等待的 `$events` 连接，且必须匹配其 Session ID。事件流会拒绝第二个 ready 帧或已被其他活动事件流占用的客户端 ID；事件流关闭时清除待处理审批。

<details>
<summary>实现细节——点击展开</summary>

此 bundle 由一层五个文件的补丁和一个运行时胶水插件组成：`cordis.patch.yml` 承载宿主行和 preset 注册表，每个 `presets/<id>.patch.yml` 插入一条随发行版交付的 preset 声明，按 `dsh.bundle.patch` 列出的顺序应用。存储栈与投影缓存来自 `dsh-base`；Web 叠加层的工作区和消息反馈条目消费共享的 `storageDomain` 服务。补丁重述 base 有意省略的界面专用值，插入 Web 专用宿主条目和浏览器插件列表，再将 Agent 层移到预设后面。胶水插件负责 dist 服务、公告应用 URL、明文 HTTP 暴露警告、提示词段落、bash 变量和就绪通知。`office-to-pdf` 条目为宿主消费者挂载一个延迟创建引擎的 [Office 转换提供方](../../document/office-to-pdf/README.zh.md)，使用此 bundle 的 Desktop 组合也共享该提供方。 转换服务的 Remote 方法负责预览读取授权，Document Preview 负责 Office 查看器和客户端缓存。

### patch 语义

patch 会替换目标行的整个 `config`，因此每个 Web 行都重述自己拥有的每个键：基础行上的 persona 前缀模板、`DSH_TOOLS_MODE` PTC mode 开关与 `session-query-sqlite` 值，随后 `insert` 添加 Web 宿主行、传输层与浏览器名录。`webserver`、`web-runtime` 与 `connection` 行都注入 `webStartup` 提供方并直接读取本次调用的取值；Connection 的被接受 authority 全部来自 `ctx.webStartup.trustedHosts`，Host/Origin 栅栏则独立于该列表接受监听器的绑定 IP。base 以进程级挂载的按 agent 工具行在这里被禁用，由 preset 名录接管；每项宿主层与 preset 层归属决策的理由以行内注释写在 patch 里。

### 公告应用 URL

启动显示与浏览器交接接收附带启动 token 的公告根；web 表层提示词与 `DSH_WEB_URL` 接收不含凭据的形式。根本身由[监听、信任与公开部署](#public-deployments)定义。

### 就绪宣告

URL 行与浏览器交接都是就绪信号：监督方一观察到该行就发起 RPC，浏览器一打开就请求页面，因此两者只在 Loader 配置树结算、通过 required 启动检查且 Connection 认证可用后运行——在没有 Loader 的手工构建树中则立即运行。此时 client combo JavaScript 和 source map 仍未物化。可选插件失败不会阻止就绪宣告；required 启动失败或启动中途被释放的树不会宣告任何内容。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `web-app` 粘合插件：dist 解析、公告应用 URL、提示词段落、bash 变量、URL 行、浏览器交接 |
| [`src/public-url.ts`](src/public-url.ts) | 公告根的校验与尾斜杠归一化；供本地导入的叶子模块，不属于包 API |
| [`src/startup.ts`](src/startup.ts) | `web-startup` 提供方：`--host`、`--port`、`--tls-cert`、`--tls-key`、`--public-url`、`--trusted-host`、`--no-open`、`--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | Web patch：重述的基础值、Web 宿主行、浏览器名录、preset 注册表 |
| [`presets/`](presets) | 每个随发行版交付的 preset（`standard`、`ptc`、`minimal`、`cordis`）各一条 `@deepseek-ai/dsh-agent-preset` 声明，各自一个补丁文件 |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | dist index 锚定、公告 URL 发布与警告、提示词段落、就绪宣告发布 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |
| [`tests/public-url.spec.ts`](tests/public-url.spec.ts) | 公告根的解析与归一化 |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | 页面可达后的默认浏览器交接 |

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

`DSH_PROFILE_MEMORY_TOKEN` 独立为父 Host 启用 `/internal/desktop-memory-sessions` 和 `/internal/desktop-memory-session`；浏览器 Cookie 和其他 worker 令牌不能授权。前一条路由每页最多返回 64 个顶层 Session ID 和版本，排除种子、委派和导入的 Session，不返回内容。Profile 本地读取器仅通过所属 Profile 的持久化服务按已验证 Session ID 寻址。它最多读取 10 万条事件和 64 MiB 当前格式 JSONL，并在持久化版本变化时拒绝结果。原始内容仅返回已认证的本地 Host；Host 在索引或传输前必须脱敏。两条路由均不授予 Renderer 或远程访问权限。

独立的 `DSH_PROFILE_REFERENCE_TOKEN` 启用 `/internal/desktop-collaboration-reference-capture`。父 Host 发送最多 32 KiB 的已授权定位、范围与接收对象选择。原文引用要求 Profile 返回确定的 UTF-16 范围，以及与引用文本精确匹配的字节长度和摘要。Session Controller 从实际内容独立生成并持久保存完整请求；响应只含最多 32 KiB 的计算元数据，不返回内容字节。Source 读取令牌和浏览器 cookie 不能捕获引用。可信父 Host 必须在调用前确认用户明确分享意图；自然语言定位和云端传递仍须独立接入。

同一个独立 Reference token 保护 `/internal/desktop-collaboration-reference-content`。私有查询最多 2 KiB，仅含原始 Source 坐标、已提交的完整引用请求摘要和字节偏移。Profile 在每次响应前重新核验当前成员关系和选中内容。响应包含最多 32 KiB 的精确分块，支持空内容且禁止缓存；Source token 和浏览器 cookie 均无读取权限。云端传递和任务附件仍由协调器负责。

同一个 Source token 保护 `/internal/desktop-collaboration-reference-grant`。私有查询限制为 2 KiB，只包含原始 Source 坐标及完整引用请求摘要。所属 Session Controller 要求独立提交的选择，并重新核验当前消息或附件字节。脱敏且不可缓存的响应只包含 Source 描述符与匹配摘要；浏览器 cookie、调用方路径或内容均不能授权此读取。

### 远端工作区目录

远端目录选择器在 Host 的屏幕上运行。选定目录获得绑定配对客户端的 Profile 内确认；`workspace.create` 在60秒内一次消费此确认，拒绝其他路径或客户端。取消不生成确认，选择器确认不会写入日志。Host 仅在安装 worker 命令执行器后公布 `profile.remote_session.directory_picker`。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到什么

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（first-party 顺序 10100，位于可复用指令之后）则向模型说明 GUI：公告应用 URL（定义见上文「监听、信任与公开部署」）、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

源码与 Web 段落位于第一方可复用指令之后。工具与配置一致时，不同 checkout 路径或应用 URL 不会改变前置前缀；不保证提供方复用缓存。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制告诉你在不常见的环境下会遇到什么——源码 checkout、SSH 会话或严格网络。它们是当前包约束，不是通用的浏览器对比或任务积压。

- **前端必须已构建**——源码 checkout 需要先运行 `pnpm run build`；dist 缺失时启动会以构建提示停止，且没有从源码直接服务的回退路径。
- **TLS 需自行启用且不代管**——只有传入 `--tls-cert` 与 `--tls-key`（完整证书链与不带口令的密钥）时监听器才提供 HTTPS；DSH 从不获取、续期或监视证书，更换文件需要重新加载监听器或重启进程。浏览器必须信任该证书，其名称必须覆盖你所访问的 authority，且证书与 `--public-url` 相互独立。
- **未启用 TLS 时外部链路是明文 HTTP**——请用终止 TLS 的代理保护它，不要在不受信任的网络上发送启动 URL。
- **只能观察到交接的启动**——GUI 只报告浏览器被请求打开，而不是它确实打开了；之后的浏览器退出永远不会上报，打印的 URL 是你的手动回退路径。
- **SSH 会话保留 URL 但跳过浏览器交接**——没有公告根时，打印的 URL 指向远端宿主机的绑定地址；SSH 客户端或编辑器必须暴露并打开本地转发地址。
- **`BROWSER` 覆盖只能来自环境**——被发现的 `.env` 不能设置 `BROWSER`；只有继承值能为自动交接选择可执行文件。
- **不支持绑定所有网络接口**——出于安全考虑，`--host 0.0.0.0` 会在启动时被拒绝；请使用一个具体的本机 IPv4 或 IPv6 地址。
- **Desktop 控制权把本地浏览器窗口视为同一方**——Profile 当前将本地浏览器窗口归为一个 Desktop 控制者。证明覆盖 Session Remote 修改与转发的审批答复；终端输入、文件上传和设置写入由其他模块负责，不在此证明范围内。


<a id="dev-note"></a>

### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

`DSH_PROFILE_ANALYSIS_TOKEN` 单独为父 Host 启用 `/internal/desktop-collaboration-analysis`。`prepare` 捕获所属 Profile 的 Source 并保存完整分析输入，等待云端资格而不调用模型。`dispatch` 仅在原归属摘要下继续同一个一次性调用，先持久保存结果再响应。最多两个待完成操作，准备和执行分别限时 30 秒；云端受理仍使用原租约，本地输出保存证据而不授予受理权限；取消、销毁、过期资格和重复请求均拒绝继续。浏览器 Cookie 和 Source 读取令牌不能授权此入口。该私有路由不授予任务受理资格，不提供可执行恢复或 Renderer API。

`read_source_output` 通过同一私有令牌读取普通 Source 已保存的原始分析。读取前后均核验当前 Session 归属，返回原描述符、已消费派发凭据、输出摘要及最多 32 KiB、以 base64url 编码的 JSON。澄清输出单独保留。缺失输出会明确返回；多个原始输出、Source 变化、归属丢失、取消或释放均拒绝。重新打开 journal 后，即使租约过期仍可读取历史证据，但不会准备模型或授予派发、云端受理资格。

`resume_source` 在确认输出缺失后，将原始未派发准备交接给当前连接。要求原文字与 mention 完全相同、当前归属有效，且 Parent 派生的 Account/Profile/Host 进程身份一致。attempt、manifest、模型及原30秒期限保持不变。旧连接派发、已消费派发、超时或进程重启均拒绝。

`capture_reply` 先保存不含新增 active mention 的补充 Source，仅保留进程内调用，不开始分析。协调器提交补充消息与选定待澄清项的关联后，`prepare_clarification` 由所属 Profile 核验完整原文及补充输入，保存新 manifest，再等待匹配计划及修订号的资格。分析身份仍为原始 Source 描述符。重复捕获仅返回不可执行恢复；并发准备、归属变化、过期与销毁均不能重建或重复派发调用。这些操作共用两个进行中操作的限制，准备和执行各有 30 秒期限。

Web 组合包含账号 Remote 控制器和账号设置页面。

`DSH_PROFILE_DELIVERY_TOKEN` 独立为父 Host 启用 `/internal/desktop-collaboration-delivery`。入口接受最多 1 MiB 的精确可读投递 JSON，由所属 Session Controller 校验原 Source 与当前归属。完整回复保存后才返回禁止缓存的首次提交描述符，不回传答案。浏览器 Cookie、Source 读取令牌、调用方提交字段及受限投影不能授权保存。取消、写入失败和提交后的归属丢失均不返回成功回执，也不删除已保存的数据。此路由不签发云端确认，不追加聊天事件。


私有 `/internal/desktop-collaboration-root` 端点复用仅父进程持有的 Source 能力，通过 `inspectCollaborationRoot` 读取持久根元数据。它只接受精确的 namespace、命令及原始来源坐标，拒绝浏览器 cookie 和绑定不符的响应，不返回来源正文或可执行 handle。路由释放时移除处理器。

私有端点 `/internal/desktop-root-journal` 要求 `DSH_PROFILE_ANALYSIS_TOKEN`，只接收不超过 2 KiB、字段严格匹配的 read/accept JSON，并返回不含 Source 正文的根元数据。浏览器 cookie 和 `DSH_PROFILE_SOURCE_TOKEN` 均不授予访问权限。Session Controller 校验归属并持久化完整原回执后才返回成功；两种操作都不会重新捕获 Source 或准备模型。

`prepare_root` 调用 `captureCollaborationRoot`，由同一个两阶段 owner 保留首次分析调用；根持久化后才确认准备完成。回复同时包含原根描述与 prepared 或 recovered Source 元数据；恢复结果不包含可执行尝试。根准备同样遵循原绑定、超时、取消和单次派发规则。根登记或规划候选保存均不授予任务执行权限。

`capture_root` 保存原始纯文本 Source 和 Root，不打开分析 journal、不提交规划 manifest，也不启动模型。原进程内调用保留当前绑定，并受30秒捕获期限限制；同绑定重复请求仅在调用未被消费时返回相同描述符。Root 持久受理后，`start_captured_root` 单次消费仍有效的调用，开始独立的30秒准备期限，并准备原始规划输入；`release_captured_root` 不经规划直接丢弃调用。两项操作均核验归属、原始输入、绑定、超时和销毁状态。恢复只返回不可执行元数据，不重建捕获调用；销毁会等待已接受的捕获完成。云端路线选择和任务授权仍由父协调方负责。

`read_root_output` 经当前 Session/Workspace 归属校验读取已受理根，再将保存输出与原始持久派发记录关联；读取后再次校验根归属。输出缺失会明确返回；记录歧义、根变化、取消或释放都会拒绝。重新打开日志仍保留原输出与派发凭据，不准备或调用模型。云端消费者提交候选前仍须独立执行原租约与栅栏校验。

`recover_root` 按 namespace 与 Source 坐标读取已有 admitted 根，要求原正文、mentions 和续接策略一致。它不捕获 Source、不准备模型、不写根，也不创建派发状态。pending 或不存在的根、输入变化、取消及归属丢失都会拒绝；本地受理回执缺失须另行对账。

`reconcile_root` 还可读取 pending 根，供 Main 查询原始云端回执；它执行相同的 Source、策略和归属校验，不受理根，也不准备模型。

`resume_root` 要求根已 admitted，且原始准备仍在相同 Account/Host 绑定下存活。重连可通过 Parent 派生的 Account/Profile/Host 进程身份交接，旧连接随即失去派发权。仅在派发尚未使用时返回相同 attempt 与 manifest；不准备新的模型调用，不延长30秒期限。进程重启、超时、归属丢失或派发已消费时拒绝。

原始分析与恢复分析 owner 会等待脱敏失败记录持久化，再结束失败的模型操作。销毁时取消工作，等待操作结算后才关闭 journal。持久失败记录仍是绑定原已消费尝试与 trace 的本地只读观察，不改变私有 HTTP 响应、云端状态、Session 日志或重放资格。

analysis token 端点管理 `prepare_root_attempt`、`inspect_root_attempt` 和 `dispatch_root_attempt`。`DesktopRootPlanning` 从旧分析 journal 或当前新尝试链确定前驱；已知派发记录或仍存活的原准备会阻止新准备。最多保留两个待处理根，准备和执行分别限时 30 秒；同连接重试保持身份和截止时间。完整输入持久化后才发布元数据，签名观察与派发前重新核验归属、当前 journal 状态，以及父 Host 推导的 Account/Profile/Host/连接绑定。worker 重启不恢复可执行句柄：重新准备未使用输入会产生新尝试，并保留前驱关系。输出保存在已消费 grant 旁，销毁等待进行中工作和 journal 写入结束。云端可替代性和 grant 认证仍由父协调方负责。

analysis-token 的 `read_root_attempt` 操作在 owner 重建后读取最新持久尝试及校验过的已保存输出，不准备模型。它在存储读取前后检查原根归属，取消或 owner 关闭后丢弃结果。过期授权仍作为已消费历史可见；派发必须另有当前云端授权。

analysis-token 的 `root_execution_journal` 操作将精确的 read/prepare/accept 请求交给所属 Session Controller。它保留 Profile 生命周期取消约束，拒绝仅浏览器授权及未知字段，仅返回持久化记录或明确的 null 读取结果，不准备模型、不向云端派发。

分析令牌保护的 `root_feedback` 操作将私有读取或入队命令交给 Session Controller，并保留取消和精确字段校验。响应只包含有界的持久化观察记录，不含结果正文。浏览器 Cookie 不能授权消费，该操作也不激活模型。

同一私有 `root_feedback` 通道也将 `consumer_prepare`、`consumer_start` 与 `consumer_read` 交给持久消费 owner。只有当前首次授权可唤醒原 Agent；start 请求的取消生命周期持续到 Agent 结算。历史读取不会恢复唤醒句柄。浏览器结果控件只经已认证 Desktop Main 提交保留的预览、任务及投递身份。

私有反馈通道还将 `continuation_read` 路由到原 Session Controller。它返回尚无已提交观察或不可变的首条回复坐标；重复读取保持原 trace，不会启动新的模型请求。

私有 NDJSON 路由也接受 `args` 为空的 `session/list`，并输出一个包含投影的完整 Session 列表快照。它沿用现有流的 512 KiB 单项上限和取消机制。

远程 `session.select_model` 和 `session.select_agent` 复用现有会话模型选择器与 Agent 预设注册表。Host 在调用 Gateway 前要求目标会话的控制权证明，响应保留已选模型或预设标识。页面不能通过选择参数指定 Profile、其他 Agent 地址或控制权世代。

绑定 view lease 的 `workbench/read` 流只允许 `workspaceFiles/read`、`readBytes`、`stat` 和 `list`，并校验精确的工作区范围与路径参数。它使用 Profile 进程内的 Connection Fetch handler，保留原有 JSON 或 multipart RPC 响应。按序分块不超过 16 KiB，完整响应上限为 34 MiB。取消会关闭所属 reader；未知接口与授权选择字段在派发前被拒绝。

同一文件能力也允许精确的 `workspaceFiles/changes` 流。Gateway 范围查找与文件系统策略继续负责授权；页面取消释放所属 watcher，每次 Host 轮询仍要求原 view lease。

个人 `settings.apply` 命令只允许原有 update、replace、mutate 表单操作。它保留 provider 的版本校验与脱敏 namespace 响应，意图上限 32 KiB，拒绝授权选择字段和不安全 JSON，并保留类型化冲突/拒绝结果，不返回私有异常文本。它不会改变选中 Profile，也不会获取会话控制权。

个人 `credentials.apply` 命令只允许精确的 set/unset。引用名沿用原语法且最多 128 字符，只写值最多 16 KiB。存储由原凭据 provider 负责。成功不返回值，已知拒绝的详情只包含引用名，不回显 provider 值或私有诊断。

受控终端操作保留原Gateway参数并拒绝跨会话输入；shell输入与生命周期变更必须使用当前Host签发的会话控制权证明。
