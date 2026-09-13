# Agent Note: 单一 Desktop Host 的 Windows 载体

Status: proposed

[English](2026-09-11-windows-desktop-host-carrier.md) | 中文

## 问题

[单一 Host 控制协议](../../implemented/architecture/2026-09-02-single-host-control-protocol.zh.md)拥有一台机器上的唯一 DSH 本地权限，但已实现载体仅支持 Unix domain。Windows Desktop 安装包不能只把套接字路径翻译成普通命名管道后就声称拥有该权限。否则，同一用户的其他进程可能先连接或冒充 broker；只有把管道、已连接进程、可执行镜像与发行身份组成一条完整验证链，才能阻止此类行为。

Windows 升级还会暴露传输层以外的产品故障。Desktop 不能把旧 profile 暂时不可用当成 DSH 本身不可用的证明。迁移失败时必须保留源数据并允许用户显式创建隔离本地 profile，同时 Host 传输仍要对不可信对端关闭失败。

## 提案

Desktop Host 包将以平台适配器形式拥有一个 Windows x64 载体。它会根据安装注册和 endpoint 注册派生不透明的命名管道名称，创建仅 owner 可访问、仅允许首实例且拒绝远程客户端的管道，并且只在专用 Worker 中执行阻塞管道操作。现有控制协议 codec 仍是唯一线协议词汇。

父线程与 Worker 将共享一个持久原子 stop flag。Worker 会把一个仅有 `THREAD_TERMINATE` 权限的真实当前线程句柄交给父线程；关停时先设置 flag，重复调用 `CancelSynchronousIo` 直至确认 Worker 退出，之后才关闭该句柄。有界重试后仍未确认停止时，系统会保留句柄并升级到 Host 进程 supervisor。这样既关闭“取消时没有挂起 I/O”的竞态，也不会把卡住的 Worker 误报为已停止。

Worker 握手绑定到不可变 generation，并且只接受一条携带该取消句柄的 ready 消息。每个已认证管道连接通过 UUID 和严格递增的请求序号映射到一个由父线程拥有的 Host 会话。只有规范化控制协议帧可以跨越 structured-clone 边界，同时最多存在一个在途请求；每个响应必须匹配连接、序号、请求 ID 和方法。任何畸形、重复、重放或跨连接消息都会使该代 Worker 失效并撤销活跃会话。

Unix socket 与 Windows 管道使用同一个认证后 Host 控制会话。该会话拥有首次 `host.inspect`、绑定进程的一次性授权、响应关联校验、连接取消和 owner 撤销。载体只提供已经认证的帧并传输返回的响应，不能定义平台专属的账号、Profile、迁移或授权分发器。

关停时先让共享 stop flag 可见并撤销活跃会话，再调用绑定 generation 的 stop 消息投递，然后才分发 abort 回调或等待会话清理。这样，stop 消息会唤醒正在等待父线程响应的 Worker，而 `CancelSynchronousIo` 会唤醒阻塞在原生管道 I/O 中的 Worker。被中止会话产生的迟到响应会被丢弃，因此两条关停路径都不能复活已撤销连接。

Worker runner 会在打开任何原生资源之前订阅父线程控制消息。如果 stop 在启动竞争中获胜，它会直接报告 stopped，而不会打开管道或取消句柄。如果线程句柄已经打开但 ready 投递失败，Worker 会自行关闭这个尚未交接的句柄；ready 成功后，只有父线程能在确认 Worker 结束后关闭它。runner 只会在对端认证成功后建立 Host bridge 连接，并通过共用原生生命周期关闭每个管道。

父线程 supervisor 会对 ready 握手、句柄交接前退出和会话清理使用注入且可中止的 deadline。任何 readiness 失败都会进入同一条幂等 stop 路径；ready 后无论 Worker 正常还是异常退出也会进入该路径，防止已交接句柄泄漏。会话清理与原生取消分开观察：畸形输入会立即撤销会话，但卡住的 `close` 不能推迟 `CancelSynchronousIo`。如果有界取消仍无法证明退出，结果会保持 `still_running` 并交给进程级 fallback，而不会要求重启或误报成功。

父线程只会用空 `execArgv` 启动文件形式的 Worker，并严格解码 generation、管道策略、共享 stop buffer、publisher 锚点和可执行文件摘要。Worker `error` 会立即使该代失效并启动取消，但只有随后发生的 `exit` 才能确认完成并允许释放句柄。如果 `exit` 在有界 `still_running` 结果之后才到达，系统会在那时关闭保留句柄，并把可观察 supervisor 状态推进到 stopped。

Worker composition root 会在加载 Koffi 或任何原生权限组件之前解码 boot data。如果进入时 stop flag 已可见，它会在零原生加载的情况下发送一条 generation 绑定的 stopped 事件。否则，线程取消、管道生命周期、阻塞 I/O 和完整 peer attestor 会作为一组 fail-closed 组件加载，全部成功后才启动 runner；不完整的原生验证链不能服务管道。

父线程 carrier 只会在 Worker ready promise 已完成且实时状态仍为 `ready` 后发布现有的无密钥 registration v1；在 Windows 上，兼容的 `socket_path` 字段承载派生后的命名管道路径。原子发布结束后还会再次检查 ready 状态，确保写入过程中发生的故障不会被返回为启动成功。构造、readiness 或发布失败都进入同一条有界 close 路径。启动后的故障由 carrier 恰好接管一次并立即开始关停。如果 stop 抛错或仍为 `still_running`，carrier 会通知 embedding 终止 Host 进程并让 close 保持失败；它绝不会声称已静默，也不会要求用户重启。Worker factory 若抛错，必须具有全有或全无语义，不能留下无人持有的活 Worker。

父线程会从当前进程 token 解析 Windows 用户 SID，而不接受 embedding 声明身份。注册根目录、锁、临时发布文件和最终注册文件都通过稳定句柄打开，并拒绝 reparse 替换与路径重定向。每个对象都必须只有一个硬链接、由该 SID 拥有，并携带受保护的 full-control DACL，且其中只能有当前用户、LocalSystem 和 Builtin Administrators；这三条 ACE 会同时继承给子文件与子目录，避免 Profile 和迁移插件回落到进程默认 DACL。注册发布采用同目录临时文件、flush、write-through 原子替换，并在替换后再次通过稳定句柄验权。单一 Host 所有权使用不共享写权限的文件句柄，而不是 PID 清理协议：进程退出会自动释放句柄，存活期间的 sharing violation 是明确冲突。系统会先取得锁，再初始化 Profile registry 或命令日志；只有管道 Worker、全部已认证会话和全部 Profile 子进程都确认静默后才释放锁。任何无法确认的停止或锁释放都必须终止 Host 进程，绝不为第二个 Host 放开租约。

Profile registry 接受一个完整的平台文件权限适配器，因此 Windows 的 registry 读取与替换会复用相同的稳定私有文件证据，同时 POSIX 路径保持不变；registry snapshot 最大字节数由启动配置注入。Windows Web Profile 也不能自行声明任意 loopback URL：Host 会通过 `GetExtendedTcpTable` 查询 IPv4 listening 记录，并要求 `127.0.0.1:<port>` 只有一个 owner，且 PID 必须等于刚启动的子进程，之后才交换一次性 bootstrap token。

Windows 启动可以在不启用迁移能力的情况下准备本地隔离 Profile。它只用 create-new 语义创建缺失文件，重试时保留安全的可变 settings、credentials、workspace 和插件内容，并要求 Host 自有 patch 精确一致。命令日志在单一 Host 租约下执行有界稳定读取与原子替换。两项权限都不接受旧数据源路径，因此迁移缺失或失败不能写入 `%USERPROFILE%\.dsh`、阻断本地 DSH，或冒充迁移已完成。

Cordis 启动会显式按平台分派。Windows 私密身份内容绝不进入环境变量：一个随签名包交付但不公开导出的引导产物，通过绑定 SID 的 create-new 文件创建 device key 与 Ed25519 安装密钥；并发创建时会重读稳定胜出文件，且只输出公开安装元数据。账号验证 keyring 通过有界 stdin 传给该子进程，以相同 ACL 权限写入隔离环境根目录，并再次校验摘要。随后 Host 先取得单实例内核租约，再重读这些精确私密文件。任何越出 root 的路径、不完整身份、公私钥不匹配、generation 冲突、畸形 UTF-8 或 ACL/reparse 漂移都会封闭失败，且不会触碰旧数据。

独立的 Main-only 客户端产物也负责 Windows 发现。它先根据受信任的安装注册与 endpoint 注册重新计算不透明管道路径，再通过 Node 命名管道客户端连接，并复用现有的新鲜 `host.inspect` 挑战。Host 安装公钥、安装 id 与可执行文件摘要必须全部匹配 embedding 持有的锚点。只有受信任注册对应的管道确实不存在时才报告 `stopped`；路径不匹配、挑战失败、协议畸形或任何其他歧义都报告 `unknown`。管道服务端会另外通过 SID、Authenticode publisher 与稳定可执行文件摘要认证已连接 daemon，因此双向都不会只信任路径。

连接建立后，Worker 会在打开仅查询进程句柄前后各读取一次管道客户端 PID。它会比较该进程 token owner 与 Host token owner，以只读且拒绝写入和删除共享的方式打开可执行文件，并按 Windows ordinal 规则比较两次进程镜像路径与最终句柄路径。随后，它会要求同一稳定句柄同时满足固定的 Authenticode 叶证书 SHA-256 与固定的流式可执行文件 SHA-256。

WinTrust 验证将不显示界面且仅使用缓存。它会让同一个 `WINTRUST_DATA` 记录从 `WTD_STATEACTION_VERIFY` 保留到 `WTD_STATEACTION_CLOSE`；只有状态零表示成功。可执行文件摘要会使用 64 KiB 分片，并拒绝超过 512 MiB 的文件、提前 EOF、零进度或变化的原生长度。

该载体保持不导出。包会把 Worker 作为独立的文件形式 bundle 携带，使父线程无需 eval 或 data URL 即可启动它；该产物刻意不进入 package exports。Slark Desktop 负责校验哈希、打包和编排该适配器，而账号、环境、迁移、fallback、发布启用和 capability discovery 策略仍位于 deepseek-harness 之外。

Main 本地凭据适配器和 Host carrier 按独立固定的摘要加载一个规范路径的 Koffi 原生模块，而不加载其 JavaScript 包装入口。父线程会把同一固定值传给 SID 解析、受保护注册文件、Profile 监听器认证和取消适配器。严格的 Worker 启动数据会把该固定值带过线程边界；Worker 在加载取消、管道生命周期、管道 I/O、可执行文件摘要、Authenticode 或对端进程绑定前会独立校验。嵌入方必须在原生加载和使用期间保证安装内容不可变；该 helper 不会因校验路径摘要就建立此权限。

## 备选方案

原生已有目录检查器独立于目录准备：检查只打开已有对象，读取句柄派生的证据，并在成功或失败后关闭句柄。复用目录准备会在盘点时创建不存在的源。路径不存在仍保留为错误，因为未验证祖先路径时，单一路径不存在不能作为全新安装的授权。完整源枚举、schema 准入和嵌入应用集成不属于这个基础接口；mock ABI 检查不能替代 Windows 原生验证。

**只使用 Node 的公开命名管道服务器。** Node 不暴露 `GetNamedPipeClientProcessId` 所需的已接受服务端管道 `HANDLE`。读取私有运行时字段会让安全边界依赖未记载的实现细节。

**只信任相同 Windows 用户 SID。** 这样，该用户拥有的任何进程都能发出 Host 命令。系统必须使用稳定镜像句柄、Authenticode 锚点和可执行文件摘要，把安装包内 broker 与其他同用户进程区分开。

**复制 macOS 载体与迁移行为。** Unix 套接字所有权、代码签名 API、启动生命周期、文件替换和进程身份不能直接映射到 Windows。系统保留共享协议与 profile 语义，但分别实现平台证据。

**在原生验证前启用载体。** 跨平台单元测试可以检查状态机和 ABI 参数，但不能证明 Windows 结构布局、签名行为、Defender 交互或安装器生命周期。因此，在取得原生证据前，capability 保持 false。

## 验收标准

固定摘要的原生辅助模块在路径与摘要验证后才创建默认加载器，并以精确的原生模块文件为基准。私有 `windows-startup.js` 产物和文件 Worker 会把该固定值传给全部生产原生调用方，而不使用 Koffi 包装入口。真实 Node 子进程测试会从内存导入已验证的启动字节，在原生加载前拒绝不支持的平台，并在不解析包的情况下到达固定值失败。包检查要求同时交付两个私有产物，且不增加公开启动器导出。发布启用前仍需 Windows 原生启动、签名进程验证和普通用户安装器证据。

目录检查会解码 SDDL 的通用权限和文件权限标记，但不会将通用掩码映射为私有文件完全控制。Windows 原生祖先目录可以包含这些标记；拒绝它们会导致路径可读时仍无法检查旧目录是否存在。未知标记和溢出掩码仍会报错。独立的 Windows 管理员探测使用明确属于当前 SID 的 fixture，区分不存在、存在、父目录缺失和其他所有者；它不证明普通用户安装行为，也不构成迁移准入。

启动产物提供旧数据探测加载器，但不提前加载原生代码。探测与本地凭据存储装配共用 SID 和固定原生模块加载逻辑，而返回的旧数据回调只捕获目录检查器。产物测试要求导出存在并拒绝缺失的发布摘要固定值；源测试区分装配与之后的元数据 I/O，并拒绝缺失的原生能力。Main 编排与 Windows 原生执行仍须分别验证。

旧主目录元数据探测将观察结果与迁移准入分开表示。读取末级目录前先检查祖先路径和主目录的当前用户归属，但分别关闭的句柄不能证明一棵稳定的目录树。因此，观察到末级目录不存在不能绕过显式 fallback 准入，也不能授权写入源。测试覆盖每一级祖先失败、原生错误来源、重定向、非法路径和非当前用户归属；仍须取得 Windows 原生与完整 schema 盘点证据。

- 原生存储测试执行真实 SID 解码与带类型的安全属性传参，在同一进程中重新打开两个存储，拒绝竞争租约，并在超限写入后保留原信封。仅 mock 覆盖不能替代此原生门禁，也不能替代独立的标准用户安装门禁。
- Windows 10 和 11 上的 Windows x64 Worker 测试证明 owner-only 管道创建、已连接 PID 证据、同 SID 强制、稳定可执行文件获取、Authenticode 验证、摘要锚定、分帧、断开与句柄清理。
- Worker 测试证明 ready 先于连接、generation 与连接隔离、顺序请求关联、畸形消息失效、响应等待关停和原生 I/O 关停，且不会泄漏会话或取消句柄。
- 共享会话测试通过两个载体接口证明 inspect-first 准入、一次性授权、响应关联、abort 驱动的 owner 撤销和幂等 close。
- Runner 测试证明启动前停止、ready 交接失败清理、认证先于会话、干净断连、畸形父线程输入，以及最终的原生 descriptor、管道和线程句柄所有权。
- 父线程 supervisor 测试证明可中止的 ready deadline、ready 前 stop 完成、Worker 提前退出、ready 后故障自动关停、不受会话清理阻塞的原生取消、有界重试、显式 `still_running` 升级，以及只在确认退出后关闭已交接句柄。
- Worker 线程与 composition 测试证明规范 boot data、仅文件且不继承参数的启动、error 立即失效但不提前确认 exit、延迟退出句柄回收、启动前 stop 不加载原生库，以及原生组件全有或全无的组合门禁。
- 包产物测试证明文件形式的 Worker bundle 会随包交付，同时不会新增公开 package export 或 Windows capability。
- 身份产物测试证明 create-new 竞态恢复、重试稳定性、精确私密路径、有界 stdin、密钥对一致性，以及“随包交付但不公开导出”的引导 bundle；Cordis 环境配置中不出现任何私密字节。
- 使用错误 signer 或摘要的恶意同用户客户端无法取得 Host 权限；精确原生诊断只保留在本地，公开协议返回封闭的权限错误。
- 全新启动、并发启动、升级、崩溃重启、回滚与关闭测试证明只有一个 Host 权限，且不会留下孤儿管道、过期注册、重启循环或源数据修改。
- Carrier 测试证明只会为持续处于 ready 的 Worker 发布注册，构造期与运行期故障只上报一次，所有启动失败都会进入有界清理，并且未确认清理必须要求终止进程而不能误报成功。
- 启动测试证明内核租约先于 registry 初始化，隔离 Profile 重试绝不覆盖可变内容，并且锁只会在管道、会话和 Profile 子进程全部静默后释放。
- 客户端产物测试证明 Windows 发现会重新计算绑定注册的管道路径、通过共享签名挑战认证 Host、只把确实缺失的受信任管道区分为 stopped，并继续保持仅依赖内置模块的独立 bundle。
- 确定性迁移失败后，Slark 可以显式创建隔离本地 profile，同时不削弱 Host 对端验证，也不改变保留的源数据。
- 在已签名 Windows 产物通过原生标准用户安装与升级验证前，公开 capability discovery、包导出、downloads 和更新元数据保持不变。
- 现有 macOS 与协议测试保持绿色；不引入仅 Windows 使用的账号、profile、会话、插件或线协议分叉。

## 风险

WinTrust 和 Koffi 涉及指针宽度布局与清理义务，单元 fake 可能错误模拟这些行为。固定的 x64 尺寸断言、真实已签名与被篡改夹具，以及 Windows 原生 CI 都是强制发行证据。

仅缓存验证不会获取最新吊销数据。设计接受该离线取舍，因为发行授权还要求精确的可执行文件摘要；启用新二进制文件前，锚点轮换与吊销响应必须更新已签名的发行 manifest。

512 MiB 摘要上限可能拒绝未来过大的安装包 broker。该限制是有意的资源边界；提高限制时必须提供经过测量的产物证据并更新原生超时预算，而不能静默覆盖配置。
