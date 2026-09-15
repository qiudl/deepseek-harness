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

Windows 安装身份准备分别接收私有存储根目录和环境根目录。它先创建普通父目录，要求环境根目录是存储根目录下 `environments` 目录的 SHA-256 命名空间，再从私有存储根目录向下按顺序创建并验证每一级私有目录。

Windows 客户端使用私有文件 Worker，在发送 Host 帧前证明已连接的管道服务端身份。Bun Main 的取消适配器由本包通过已验证的客户端产物提供；调用方传入发布版本固定的 Worker，并且必须只选择一种对端身份模式。Authenticode 模式固定发布者指纹；Store 模式固定 package family name，并要求可执行文件保留在该包的受保护安装根目录内；两种模式都固定可执行文件摘要。只有确认 Worker 退出后，才能关闭其移交的线程句柄。

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

macOS 启动组合会校验 owner-only 且非符号链接的根目录，只启动一个 Host，分别检查 Node executable 与固定 DSH entrypoint，按照嵌入应用发布版本提供的 SHA-256 pin 校验 Account 公钥环，执行原生 peer PID／executable／code-signature attestation，并发布不含秘密的精确 `~/.dsh/host/registration.v1.json` discovery 记录。取得 Host 独占所有权后，Runtime 升级只能原子刷新该记录的 executable signature digest；installation、key、endpoint 和 socket 字段必须全部保持一致。Profile worker 不继承 ambient environment。Windows 通过有大小上限的私有文件描述符管道传递明确的 Profile 环境，因为打包子进程可能丢弃自定义环境值；bootstrap 在导入固定的 DSH entrypoint 前清除 ambient 值。Host 校验子进程确实拥有其报告的 loopback listener，自行把一次性启动 token 兑换为签名 Cookie，确认未认证 `/` 为 401、携 Cookie 的 `/` 为 200，然后立即丢弃 token。

命令写入按 Profile 与 Session 串行，不同 Session 可并发。fsync 日志在执行前记录 `started`，随后记录 committed outcome；两者之间崩溃恢复为 `unknown`，绝不推断成功。审批决策同时比较 payload hash、decision version、window generation 与过期时间。环境上下文只附着到 Session lease，不形成 Profile 全局状态。

<a id="model-experience"></a>
## 模型体验

无，因为本包没有面向模型的注册。

#### KV Cache 影响

不会直接失效；Host 控制事实不进入模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **解锁材料仍由嵌入应用拥有**——Slark Main 必须把随机 32 字节 Profile material 保存在 macOS Keychain／safeStorage 中，并且只通过已认证 Main-to-Host 链路提供；它绝不能进入 Renderer、argv、environment、日志或 registration 文件。
- **Account access 与 session 绑定**——Slark Main 必须从 DSH Account 获取 `dsh-host` token，并且只通过已认证 Main-to-Host 链路提供。Host 不持久化或记录该凭据；token 过期后，Slark Main 必须刷新 Account session，`profile.ensure` 才能成功。
- **旧数据迁移在完整闭环前 fail closed**——只有 active Profile 的完整 owner-only bundle（session、settings、credential、workspace 与 Profile 配置）可被 stage 时，Host 才发布 export 能力。digest-only 或 session-only transfer 不会被宣称为安全迁移。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

参见[单 Host 控制协议 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-02-single-host-control-protocol.zh.md)与[打包 Windows Profile 配置 Agent Note](../../../.agents/notes/implemented/bug-fix/2026-09-15-windows-packaged-profile-worker-configuration.zh.md)。

REQ-20260911-0004 的原生存储证据仅来自 Windows 11 x64 管理员环境中的独立合成信封探针：创建、读取、重新打开、竞争租约拒绝、替换，以及超限写入后保留原数据均通过。SID 解码使用 LPWSTR 输出 slot；文件创建使用带类型的安全属性指针；重复加载使用匿名结构。此探针尚未验证标准用户安装、加密、签名载体集成或完整 Desktop 启动。

</details>
