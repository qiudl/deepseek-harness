---
description: "供可信 Desktop 代理使用的本机单 DSH Host 权威与已认证 Unix 传输。"
kind: "package-bundle"
---

# dsh-desktop-host

[English](README.md) | 中文

## 概述

本包提供 Desktop Main 使用的本机 DSH Host 权威。它让 issuer-qualified Person Profile 独立于 Slark 环境，串行化同一会话命令，围栏审批与环境上下文租约，监管相互隔离的 Profile worker，并提供 owner-only 的已认证 Unix socket。Host 控制组件不拥有 HTTP listener；产品组合会启动既有 `dsh web` worker，由 Host 自行兑换一次性启动 URL，并且只向可信 Main 返回已校验的 loopback origin 与 HttpOnly Cookie 名称／值。启动 token 和文件系统路径都不会进入 Renderer。

## 目录

- [Desktop adapter](#desktop-adapter)
- [Profile 与执行权威](#profile-and-execution-authority)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="desktop-adapter"></a>
## Desktop adapter

固定摘要的原生辅助模块只在验证精确原生模块路径和字节后创建默认加载器。导入该辅助模块不会解析原生包。私有 `windows-startup.js` 组合会把同一发布固定值传给父线程的 SID、注册、监听器和取消适配器，并把它放入严格解码的 Worker 启动数据。文件 Worker 会独立重新校验并加载这个精确原生模块，供取消、管道 I/O、生命周期和对端认证使用。两条生产路径都不会搜索 Koffi 包；嵌入方仍须验证发布元数据，并在整个使用期间保护已安装文件。

Windows 目录安全证据将 SDDL 的通用权限、标准权限和文件专用权限保留为无符号位掩码。未知标记和超过 32 位的掩码会使检查失败。解析通用权限不会授予私有存储访问权：私有文件仍要求精确的、受保护的三主体文件完全控制 DACL。

启动产物向可信嵌入代码提供 `loadWindowsLegacySourceProbe`。装配通过与本地凭据存储相同的发布版本固定原生模块解析当前进程 SID，不检查旧数据文件系统，并且只返回只读探测函数。不支持的平台、缺失摘要固定值、原生身份解析失败或缺少目录检查器都会使加载失败。嵌入方必须在后续探测调用期间持续保护原生模块，并提供操作系统选定的用户主目录。

Windows 原生目录检查器读取已有路径的属性与安全证据，不创建目录或修复权限。路径不存在、访问被拒绝、共享冲突和检查失败均抛出错误。该证据不授权迁移，也不证明读取句柄关闭后的祖先路径安全性；完整旧数据盘点仍是独立工作。

旧主目录元数据探测区分观察到的 `.dsh` 末级目录缺失、目录存在和无法确认。它先检查祖先路径，拒绝重定向路径及非当前用户拥有的用户主目录，不读取目录内容，并将已有空目录视为存在。只有原生末级打开操作的文件不存在错误才产生“观察到不存在”；任何结果都不授权迁移或创建替代 Profile。仍须完成源枚举、schema 检查和稳定目录树验证。

`discoverUnixHost` 返回 `running`、`stopped` 或 `unknown`。只有注册表信任的 endpoint 确认没有监听进程时才返回 `stopped`；UID、安装密钥、可执行文件签名、challenge、帧或 socket 类型验证失败一律返回 `unknown`。

Windows 本地 Profile 存储接收嵌入方加密的信封，大小不超过 16 KiB。它复用原生 SID/DACL 与重解析点检查，替换文件前要求已验证的文件租约，并在同步回调结束（包括失败）后释放租约。文件不存在时返回 null；权限与完整性错误不授权创建新身份。原生装配要求一个路径规范、只有单个硬链接的 Koffi 原生模块，以及经过独立发布验证的 SHA-256；绝不搜索其他包或路径。加密、环境根选择，以及加载和使用期间防止原生模块被替换，均由嵌入方负责。仅校验摘要不能证明 Windows 安装目录 ACL 或发布者签名；仍需原生安装验证。

Windows 客户端使用私有文件 Worker，在发送 Host 帧前证明已连接的管道服务端身份。Bun Main 的取消适配器由本包通过已验证的客户端产物提供；调用方传入发布版本固定的 Worker 和发布者信任锚。只有确认 Worker 退出后，才能关闭其移交的线程句柄。Windows 分发仍须通过签名 Carrier 和原生安装验证。

Windows Host 启动按 Windows 文件 URL 规则转换规范的绝对 Worker 路径，保留安装目录中的 Unicode、空格、百分号和井号字符。

客户端取消逻辑会接管启动取消后才移交的线程句柄。取消重试预算耗尽时，父线程继续持有该句柄，直到 Worker 后续正常或异常退出，确认可以关闭；预算耗尽不代表已经停止。

`UnixHostClient` 提供 Profile 的账号 ensure／restore／status／open、本地 bootstrap／restore／open、view activation／close 与 owner-only 迁移操作。本地操作不接收账号身份、token、binding 或 environment assertion；Host selector 与 Keychain material 可在后续 authenticated connection 上恢复本地专用 Profile。同一 authenticated owner 再次打开相同 Profile 时，Host 会原子延长现有短时 view lease 并签发新的单次 activation handle，使活跃 Desktop 无需替换 renderer 即可续期授权。`profile.ensure_account_token` capability 标识 Host 接受带 token 的 `profile.ensure` 载荷；当该 capability 缺失时，任一 peer 都会在 mutation 前报告 `upgrade_required`。`profile.ensure` 要求携带面向 `dsh-host` audience 的短时规范 DSH Account token；Host 离线校验该 token，并在任何 Profile registry mutation 前要求其 issuer 与 subject 和请求账号一致。每个操作都接受 `AbortSignal`。中止会销毁已认证连接，Host 会撤销该连接拥有的全部 view lease 和 Profile 解锁引用；另一个已独立证明同一 Profile 的 staging 或 production 连接仍保持授权。

连接以 `host.inspect` 开始：Desktop 提供新鲜 challenge，并校验安装 Ed25519 签名、可信安装 id 与公钥、peer UID、可执行文件签名摘要、Host process nonce 和 runtime generation。后续帧重复 client、Host 与 process 身份，并携带最长 30 秒、只能使用一次的 JTI。

<a id="profile-and-execution-authority"></a>
## Profile 与执行权威

账号 provisioning 在 worker 准备失败时保留精确的原注册表记录，包括 issuer 或 subject 替换的情况。注册表出现并发变更时，回退被阻止并返回 `stale`。缺少 worker 提供方时，在登记前拒绝操作。这些规则只影响注册表元数据，既不授权云端身份迁移，也不移动或删除 Profile 内容。

恢复不含可选绑定字段的记录后再添加账号绑定时，Host 按注册表的规范字段顺序写入，使更新后的记录在 Host 重启后仍可读取。

Profile registry 为每个 Profile 保存 opaque Profile id、opaque Keychain handle 与域隔离 unlock verifier。账号 Profile 还保存规范 DSH Account issuer 与 opaque subject 的设备密钥 HMAC，以及按环境划分的当前 binding handle／version；同一个人的 staging 与 production binding 解析到同一账号 Profile。本地专用 Profile 使用设备密钥随机 index，永远不会获得账号 binding。更高的服务端签名 binding version 只原子替换对应环境的旧账号 handle，并使旧签名 selector 失效。替换 Account issuer 时，只有请求携带同一环境 binding handle、严格递增的 version、相同 Keychain handle、匹配的 unlock material，以及替代身份的有效 token，Host 才会保留原 Profile。文件中不含原始账号身份或 Main vault 的 32 字节解锁材料；常量时间校验成功后只授权当前已认证连接。

`profile.ensure` 返回绑定 installation、Profile、binding generation、runtime generation 与 schema generation 的 Host 签名 opaque selector。`profile.restore` 接受该 selector、精确 Keychain handle 与新鲜 Main-vault material。跨 installation 复制、binding 轮换后重放、猜测 handle／material，或证明连接断开，都会 fail closed。

macOS 启动组合会校验 owner-only 且非符号链接的根目录，只启动一个 Host，分别检查 Node executable 与固定 DSH entrypoint，按照嵌入应用发布版本提供的 SHA-256 pin 校验 Account 公钥环，执行原生 peer PID／executable／code-signature attestation，并发布不含秘密的精确 `~/.dsh/host/registration.v1.json` discovery 记录。取得 Host 独占所有权后，Runtime 升级只能原子刷新该记录的 executable signature digest；installation、key、endpoint 和 socket 字段必须全部保持一致。Profile worker 不继承 ambient environment。Host 校验子进程确实拥有其报告的 loopback listener，自行把一次性启动 token 兑换为签名 Cookie，确认未认证 `/` 为 401、携 Cookie 的 `/` 为 200，然后立即丢弃 token。

命令写入按 Profile 与 Session 串行，不同 Session 可并发。fsync 日志在执行前记录 `started`，随后记录 committed outcome；两者之间崩溃恢复为 `unknown`，绝不推断成功。审批决策同时比较 payload hash、decision version、window generation 与过期时间。环境上下文只附着到 Session lease，不形成 Profile 全局状态。

扩展操作所有者生成短期有效、绑定 Profile 的计划，并在执行器产生副作用前持久化仅含元数据的回执。`DesktopHost.authorizeExtensionView` 根据有效的窗口租约和可写 Profile 授权解析目标；调用方必须在每次修改前重新验证授权。同一 Profile 的写入串行执行，重复确认不能创建另一项操作；取消在执行器结束前仅表示请求。未完成回执恢复为 `unknown`，阻止该 Profile 的后续写入，绝不自动重放。执行器必须等待其子进程和写入停止后才结束；扩展操作完成资源释放前，必须继续持有 Host 进程锁。

MCP 执行器复用 [hub-upstream](hub-upstream/UPSTREAM.json) 中固定版本的 Desktop Hub 解析器和 AST 合并逻辑，保留其他配置行、注释与环境变量引用。它仅原子写入 Host 解析出的 Profile 的 `profiles/web/cordis.patch.yml`，随后重启该 worker，并检查经过认证的 `pluginInventory/list` 响应。安装行启用 `failOnStartupError`，使激活成功包含首次连接和工具发现成功。重载失败时，仅在操作仍持有授权且文件修订值未变的情况下恢复旧内容或原先的文件缺失状态。修订值区分配置文件缺失与空文件。只有恢复后的 worker 确认原 MCP 条目且失败操作引入的条目已消失，才确认失败；恢复不确定则保持未知。worker 启动、确保运行和释放按 Profile 串行，包括尚未结束的启动操作。

MCP 删除只接受针对一个现有本地 MCP 行的 `{ "action": "remove", "id": "mcp-name" }`。它复用 Hub 的 AST 删除方法，只有被删行对应的 `include:` 条目从重启后的 worker 中消失，才记录成功。配置了删除能力时，MCP 清单声明 `mcp_remove: true`；缺少该标记时，调用方必须禁用删除。 MCP 更新接受 `{ "action": "update", "id": "mcp-name", "mcpServers": { "name": {} } }`，其中必须填写该现有名称的完整替换配置。它复用 Hub 行更新、相同的重启确认与失败补偿，入口由 `mcp_update` 标记控制。显式 SSE 或未知传输类型在 Hub 转换前被拒绝。

内部 [Skill 执行器](src/profile-skill-executor.ts) 复用 Hub 固定版本的 Markdown 生成逻辑，在 Host 解析出的 Profile 下创建一个新的 `skills/<name>/SKILL.md`。它拒绝已有同名技能、不安全文件系统条目和并发发布，使用私有权限并同步到磁盘。调用方的运行时生效确认必须返回所选预设作用域内、不按调用权限过滤的技能定义。执行器将其 Profile 路径、来源、名称、描述、路由提示、正文和调用标记与发布的 Markdown 比较；空确认不能代表成功。启动组合在同一 Profile 队列中注册两种安装器。技能发布后重启 worker，使用 Host 持有的 Cookie 读取 `skills/inspectProfile`；接口挂载默认预设的 standing scope，不启动 Session，也不传项目 cwd。确认仅证明默认预设可见性，不代表所有自定义预设或项目都可见。部分发布后的核对仍不属于此组件。

技能调用开关复用 Hub 的 AST 更新方法，生成的辅助函数移除了文件系统副作用。Host 只接受现有本地条目 ID、模型/用户选项及布尔值；原子替换 Markdown，保留其他元数据和资源，并在重启后核验默认预设。生效确认失败时，仅在修订和授权仍有效的情况下恢复原字节并核验恢复结果。清单只返回从文件读取的 `model_invocable` 和 `user_invocable` 标记，不含指令正文；这些标记描述本地配置，不代表所有预设均可见。Desktop 根据 `skill_invocation` 能力启用开关。

Markdown 文件导入接受 `{ name, markdown }`，保留原始字节、元数据和调用标记。声明名称必须与有效 frontmatter 一致；确认前检查描述、正文、调用字段类型和载荷大小。完整 JSON 计划不超过 32,768 个 UTF-8 字节，正文不超过 24,576 字节。拒绝已有同名技能。`skill_files` 声明此新文件导入能力，不允许 ZIP 上传，也不读取调用方提供的本地路径。

[资源包安装器](src/skill-archive.ts) 接受 Main 下载预览后提供的公开 GitHub codeload URL、所选子目录和 SHA-256 摘要。它再次下载但不跟随重定向，写文件前校验摘要。它保留原始 Markdown、资源字节和脚本的所有者执行权限，安装时不执行脚本；全部资源参与修订检查及生效确认后的核验。压缩包上限为 50 MiB、512 个条目、单文件 10 MiB、总展开大小 100 MiB；路径穿越、链接、大小写冲突、不明确的技能根目录和名称不匹配均被拒绝。只有配置了该执行能力时，技能清单才声明 `skill_archives: true`。不支持 ClawHub、本地资源包上传或任意下载主机。

内部[插件命令执行器](src/plugin-command.ts) 复用 Hub 固定版本的参数构造器，显式指定 Node、CLI 和 pnpm 路径。它提供私有命令入口、所选 Profile 主目录，以及用于共享包缓存的操作系统用户主目录，不转发环境变量中的凭据。它禁用生命周期脚本，消费输出但不记录内容，并在取消、租约撤销或两分钟超时后终止进程组。CLI 退出不等于激活成功；启动流程在提供打包 pnpm 路径时注册组合包执行器；生命周期脚本保持禁用，尚不开放构建批准。

内部[插件执行器](src/profile-plugin-executor.ts) 将不可变来源与包名绑定到所选 Profile，拒绝替换已声明的包，并对主目录和 Profile 的清单、锁文件、构建策略、仓库配置及补丁计算指纹。只有 Host 提供的组合包加载确认完成且安装后版本指纹未变化，才记录成功。部分安装和激活失败保留为结果未知，不自动回滚或重放包管理器文件。启动流程重启所选 worker，并通过其经过认证的插件清单检查发生变化的已启用根条目。空贡献、被覆盖、被移除、分组或条件条目无法建立此加载确认，会保留结果未知回执。

可选启动字段 `pnpmEntrypointPath` 通过 `DSH_HOST_PNPM_ENTRYPOINT` 接收打包后的命令路径。启动流程校验此文件，并仅在字段存在时注册插件操作；旧版集成继续提供 MCP 和 Skill 操作。

可选[真实 worker 探测](tests/plugin-worker-live.spec.ts) 要求 CLI、Client 包和 Web 资源已构建。设置 `HOST_PLUGIN_LIVE_WORKER=1` 和 `SLARK_PLUGIN_ACCEPTANCE_ROOT` 后，[插件集成测试](tests/plugin-command-integration.spec.ts) 还通过 Unix socket 驱动真实 Slark broker、本地接口、桌面安装协调器和回执日志，从本地回环仓库安装插件，重启正式 Web worker，并验证其认证清单与更新的 worker 代次。测试替代了目录预检、确认和操作系统进程身份校验，不证明原生批准点击或签名应用。

Windows 回执存储复用现有私有文件接口，原子替换有容量上限的记录集合。每次读取均核验 SID 所有权、受保护的 DACL、链接数量与重解析点证据；损坏或超限数据会拒绝访问，不会变成空历史。共享操作管理器将中断记录转为待核实，不会重放。嵌入应用提供正数 `maximumExtensionReceiptBytes` 后，Windows 启动端启用 MCP；省略该字段时扩展不可用。启用后支持 MCP 清单、安装、更新、移除及显式恢复，并在销毁 worker 和释放 Host 锁之前等待操作停止。

MCP 配置解析和运行确认由 POSIX 与 Windows 存储适配器共用一个执行器。Windows 启动产物内联 YAML 的 ESM 版本，使校验后的字节可从 data URL 加载，无需查找依赖包或使用依赖文件路径的 CommonJS 加载器。Windows 存储校验 Profile 私有目录及文件证据，独占创建操作备份，并在恢复时区分配置文件不存在与空文件。删除操作在同一个独占原生句柄上比较预期内容并校验 SID/DACL，最后检查授权后设置句柄删除状态，不重新按路径打开文件执行删除。启用 MCP 时，Host 在启动 Profile 前创建缺失的私有 web 目录及初始配置；重启会保留 MCP 字节上限内的自定义配置。权限异常或继承权限的现存路径会被拒绝，不自动修复；这些现存 Profile 的迁移仍需单独处理。

<a id="model-experience"></a>
## 模型体验

无，因为本包没有面向模型的注册。

#### KV Cache 影响

不会直接失效；Host 控制事实不进入模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **扩展支持由执行器决定** — `profile.extensions` 通过有效窗口租约接受清单、准备、提交、状态和取消请求。插件执行要求配置随包 pnpm 产物。Windows 启动组合支持显式启用的 MCP，Windows 插件及 Skill 执行器仍不可用。嵌入应用必须启用并固定此组合的版本，用户才能获得该能力。技能清单使用 `transport: markdown` 和有长度限制、由文件名生成的标识。安装或恢复配置导致 worker 重启后，Desktop 必须重新打开同一 Profile 视图。打包运行时固定版本、完整 Profile 迁移保留、杀进程恢复和未知回执核对，仍需在发布前单独完成端到端验证。

- **解锁材料仍由嵌入应用拥有**——Slark Main 必须把随机 32 字节 Profile material 保存在 macOS Keychain／safeStorage 中，并且只通过已认证 Main-to-Host 链路提供；它绝不能进入 Renderer、argv、environment、日志或 registration 文件。
- **Account access 与 session 绑定**——Slark Main 必须从 DSH Account 获取 `dsh-host` token，并且只通过已认证 Main-to-Host 链路提供。Host 不持久化或记录该凭据；token 过期后，Slark Main 必须刷新 Account session，`profile.ensure` 才能成功。
- **旧数据迁移在完整闭环前 fail closed**——只有 active Profile 的完整 owner-only bundle（session、settings、credential、workspace 与 Profile 配置）可被 stage 时，Host 才发布 export 能力。digest-only 或 session-only transfer 不会被宣称为安全迁移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

参见[单 Host 控制协议 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-single-host-control-protocol.zh.md)。

REQ-20260911-0004 的原生存储证据仅来自 Windows 11 x64 管理员环境中的独立合成信封探针：创建、读取、重新打开、竞争租约拒绝、替换，以及超限写入后保留原数据均通过。SID 解码使用 LPWSTR 输出 slot；文件创建使用带类型的安全属性指针；重复加载使用匿名结构。此探针尚未验证标准用户安装、加密、签名载体集成或完整 Desktop 启动。

</details>

经确认的 Markdown 替换通过独立的 `skill_replace` 能力接受 `{ action: "replace", id, markdown }`。精确的 flat/bundle ID 和 frontmatter 名称必须匹配已有自有条目。更新复用调用开关的原子发布机制，保留目录资源；生效确认失败时，仅在修订和授权仍有效的情况下恢复。成功要求默认预设中的新定义匹配；仅恢复字节而未确认运行时恢复，不能报告已明确失败。

经确认的技能删除通过 `skill_remove` 能力接受 `{ action: "remove", id }`。Host 将精确的自有文件或目录移至 Profile 内的私有暂存位置，重新加载默认预设后才清理暂存资源。观察结果仍指向原路径时不能确认删除。成功回执持久记录有界的 `skillSource`：`absent` 或观察到的接替来源，不宣称所有同名技能都消失。观察失败时，仅在修订、授权和暂存字节仍有效的情况下恢复完整条目并核验恢复。冲突时保留暂存条目和未知回执供核对，不覆盖其他作者的新内容。

内部[插件包启停规划器](src/plugin-toggle-plan.ts) 使用 app-boot 配置组合控制独立插入的根条目，拒绝共享配置修改、分组或条件贡献、缺失插件包及后续覆盖冲突。插件执行器仅在配置了规划及生效确认时接受经确认的 `{ action: "toggle", packageName, enabled }`。它原子发布 Profile 补丁，保留标签值和注释；确认失败且修订与授权仍有效时恢复原补丁。启动组合重启 worker；停用确认要求精确模块处于 `enabled: false` 且没有 fiber。包依赖仍保留安装。Desktop 使用显式 plugin_toggle 能力与逐条目的配置状态开放经系统确认的启停按钮。

插件清单通过可选 `plugin_state` 返回 `enabled`、`disabled`、`mixed` 或 `unsupported`，描述组合后的配置，不代表当前 fiber 健康。启用与停用两个方向都必须可以独立规划，才开放条目操作；旧版和不支持的条目保持按钮禁用。真实 CLI/worker/Slark 夹具安装一次并停用、再启用，通过三次新 worker 代际验证回执查询及清单状态变化。Electron 夹具另以注入 provider 验证 renderer/preload/dispatcher 行为。

经确认的插件更新使用 `{ action: "update", packageName, spec }` 和现有精确来源 add 命令。仅允许由依赖管理、可独立且全部启用的插件包更新，避免停用、混合或不支持的组合意外增加启用功能。Main 通过 Hub 预检锁定所选来源，并要求包名匹配已有条目。CLI 必须发布请求版本，新 worker 确认贡献后才成功；依赖部分变更保留未知回执，不假装已经回滚。

经确认的卸载使用 `{ action: "remove", packageName }`，仅接受由依赖管理的独立插件包，并调用固定 CLI 的 remove 命令。pnpm 11.7 的 remove 要使用 `--config.ignore-scripts=true`，会拒绝 add 可用的 `--ignore-scripts` 写法。确认依赖及插件包登记已移除后，Host 清理原贡献 ID 对应的独立 `{ id, disabled }` 覆盖，保留其他配置，再要求对应运行时 ID 全部消失。模板内置包不可卸载。真实安装/更新/卸载夹具中的生命周期脚本哨兵始终未生成。

技能列表将自有本地条目与当前 worker 经认证的 `skills/profileCatalog` 快照合并，读取不重启 worker。读取期间本地修订变化、快照不完整、胜出名称重复或合计超过 128 条时拒绝读取。条目仅公开有界来源类别，以及 `effective`、`shadowed` 或 `not_visible` 状态；被覆盖的本地条目标出生效来源。外部胜出条目使用不透明的 `catalog-` ID，在 Desktop 中只读。提供方路径保留在 Host 内部。列表范围是自有本地定义和默认预设胜出条目，不包含所有外部落选候选项或项目专属预设。

技能删除在移动条目前将检查点持久写入私有操作回执。检查点把精确的 flat/bundle ID、原内容摘要、变更前及预期变更后本地修订、删除或恢复核验阶段绑定到原操作和 Profile。暂存名称由操作 UUID 推导；已有暂存条目绝不替换。初始检查点存储失败时不移动文件。进程崩溃可能让最后持久阶段落后于文件系统，因此检查点仅是后续核对证据，不能据此直接宣称成功或自动恢复。普通协议回执不返回这些 Host 内部字段。

经确认的技能恢复使用普通 Skill 准备载荷 `{ action: "restore-removal", operationId }`，引用同一 Profile 中结果未知的删除回执。Host 核验原检查点、精确备份摘要、目标占用及变更前/删除后修订；计划同时绑定检查点摘要。恢复在文件变更前持久保存独立 UUID 和指向原回执的 `restores` 关联。执行时移回已核验备份，或对已经移回且字节相同的文件重新核验，随后确认默认预设实际定义。关联恢复回执成功后，原删除及相关中断恢复尝试不再阻塞后续操作，但历史结果不改写。无关未知操作仍阻塞。旧回执缺少检查点或存在冲突时不能猜测恢复。本能力仅限 Skill 删除，不恢复其他 Skill 编辑或插件包管理器副作用。


MCP 操作先以排他创建方式持久保存私有备份，再记录检查点并发布配置。检查点包含变更前后修订、原文件存在状态、新增条目 ID 和单调推进的阶段，不包含配置正文。备份最大为 1 MiB 加一个存在标记字节，归 Host 用户所有，权限为 0600，且只有一个硬链接。备份随操作证据保留；本接口不提供自动保留清理。

带恢复证据的未知 MCP 回执声明 `mcp_restore: true`。普通 MCP 准备载荷 `{ action: "restore-config", operationId }` 将新确认绑定到原检查点与当前组合修订。恢复仅接受记录的变更后修订，或已经恢复且完全一致的变更前修订；保留原文件缺失状态，并核验原运行时条目与新增条目的消失。备份缺失、被修改、存在链接、权限公开或配置并发修改时拒绝恢复。关联的成功回执解除相关未知操作的写入阻塞，不改写历史结果。MCP 恢复仅还原配置，不覆盖子进程或远程服务的副作用。

插件启停变更持久保存原操作持有的私有配置备份及检查点，绑定包名、备份摘要、变更前后依赖状态修订和阶段。未知启停回执通过 `plugin_restore` 返回包名。插件准备载荷 `{ action: "restore-toggle", operationId }` 创建新的确认恢复操作。Host 仅接受记录的变更前后状态，核验替换原配置后精确得到变更前修订，并从已安装组合包重建原启用和停用条目的运行时预期。清单、锁文件、策略文件或覆盖配置变化时拒绝恢复；备份缺失、被修改或权限公开时也拒绝。恢复保留原文件缺失状态，不调用包管理器，并确认原 worker 状态。历史结果保持不变，通过成功恢复回执关联。备份随证据保留。本操作仅恢复启停配置，安装、更新和卸载的部分变更仍保持未知。

插件包操作在调用命令执行器前持久保存不可变的安装、更新或卸载意图。证据包含精确请求来源、原依赖引用摘要、无关清单/策略/覆盖配置状态摘要、原移除条目 ID 和单调推进的阶段。回执不保存原依赖引用或配置正文。私有回执读写均限制为 64 KiB，以容纳有界的组合包移除 ID。带证据的原未知回执可声明 `plugin_complete`，通过独立确认的 `{ action: "complete-package", operationId }` 计划继续执行。计划绑定包含锁文件的当前修订及原意图摘要，不接受客户端替换来源。

继续执行保留无关依赖声明、组合包顺序、策略文件及覆盖配置，仅接受目标缺失、目标匹配原依赖摘要或目标匹配精确请求引用。无关变更使准备失败，命令结束后还会再次核验。命令中断可能合法改变依赖解析，因此部分锁文件变更不纳入无关状态摘要；确认和提交仍绑定完整当前锁文件修订。安装和更新使用原固定来源重新执行 add，并禁用生命周期脚本。卸载时若依赖仍存在则重新执行 remove；依赖已缺失时，用固定 CLI 命令 `plugin --profile web install --no-frozen-lockfile --ignore-scripts` 按当前清单修复依赖树，随后 Host 仅清理原目标的残留组合包登记和独立启停覆盖。必须通过运行时确认和最终修订稳定性核验。再次中断仍保持未知，需要再次显式确认。

成功继续执行使用 `completes_operation` 和 `completed_by`，与恢复关联字段区分。原操作及相关中断继续操作保留未知历史结果，仅由关联的成功回执解除这一组操作的写入阻塞。继续执行要求有效的 Profile 授权租约和完整意图证据。不猜测缺少意图的旧记录，也不保证修复无法建立租约的 Profile、损坏清单、不可用包来源或插件外部副作用。
