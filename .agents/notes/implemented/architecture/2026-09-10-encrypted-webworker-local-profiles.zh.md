# Agent Note: 加密的 WebWorker 本地 profile

Status: implemented

[English](2026-09-10-encrypted-webworker-local-profiles.md) | 中文

## Problem

浏览器承载的 Harness 需要持久本地 workspace，且不能把 Slark 登录、邮箱绑定、云端工作台或 Desktop 安装作为前提。WebWorker VFS 原本仅驻留内存，可选 fixture overlay 是静态启动输入，不是用户拥有的存储。持久化明文会让任何能读取源站数据库的主体看到对话和 workspace 文件；把数据密钥与密文放在一起则只有加密形式，没有数据保护。本地 profile 还需要单写入者、严格环境隔离，以及浏览器无法保证持久化时的明确行为。

## Decision

**DSH 源站拥有每个浏览器本地 profile。** 页面创建或解锁 profile，通过 structured clone 把不可导出的 AES-256-GCM 数据密钥传给同源 dedicated Worker。Slark 可以选择模式或移交可选在线连接，但其源站不拥有 profile 数据库或密钥材料。`environmentId` 与 UUID `profileId` 组成存储 namespace，并同时绑定密钥 wrapper、profile key check、Web Lock 和每个文件密文；Staging 与 Production 永不复用 namespace，也不静默回退到另一环境。

**独立的 passkey 与恢复 wrapper 保护随机数据密钥。** 注册流程先经版本化 PBKDF2-HMAC-SHA-256 参数从规范化的恢复口令派生 AES-KW 密钥，再要求用户验证并请求 WebAuthn PRF extension。PRF 输出通过 HKDF 派生另一把不可导出的 AES-KW 密钥。两把密钥包装同一个新的 AES-GCM 数据密钥，源站 registry 只存储严格校验后的 wrapper 元数据。WebAuthn 允许注册仅报告支持 PRF 而不返回求值结果，因此遇到这种情况时，注册流程立即为新 credential 请求 assertion。两条解锁路径都要求调用方给出预期 environment 和 profile 标识；passkey 解锁还要求用户验证并命中准确 credential。IndexedDB 永远不接收解包后的密钥。

**恢复迁移完整、受认证且原子。** registry、VFS key-check 记录和加密 entries 共用同一个版本化 IndexedDB。新 profile 初始化会一次提交 registry record 与 key check；导出读取一致快照，导入在一个 transaction 内提交全部 store。恢复包只把恢复 wrapper 与 environment/profile header 放在外层，再使用 profile 数据密钥加密并认证完整快照。导入会在密钥派生前校验用户所选 environment，随后认证恢复包、检查内嵌 VFS key record；只要目标已有 registry、profile 或 entry，就拒绝导入，不做合并或覆盖。当前内存 JSON 格式有明确的 256 MiB 序列化上限。

**持久 VFS 状态是受限的加密 overlay。** Worker 先向 Storage API 请求持久化并取得独占 Web Lock，再打开 IndexedDB。它只镜像 `/dsh/home` 与 `/dsh/workspace` 下的规范路径；runtime module、配置和临时文件仍属于镜像或当前会话。每条文件和目录记录都经过加密，AES-GCM additional data 认证其 namespace、格式版本、路径、类型、mode、修改时间和可选硬链接组。完整硬链接集合在一个 IndexedDB transaction 中提交，并在 Cordis 启动前覆盖到不可变镜像与已选 fixture overlay 之上，恢复为同一个文件身份。

**本地就绪独立于在线就绪。** 未选择 profile、持久存储被拒、数据库不可用或缺少 Web Lock 时返回明确的 `session_only`，内存态 Harness 仍可启动。另一个标签页已打开 profile、密钥无效或 profile 元数据损坏时，以不同原因码 fail closed。write-behind 失败会停止后续镜像并保留当前内存会话。Worker 启动失败和正常销毁都会释放 Web Lock；正常销毁先停止 Cordis tree，再 flush 排队中的 VFS 写入。

**产品启用还依赖剩余呈现责任方。** preview 不传 `localProfile`。在 DSH 源站提供首次使用与迁移 UI、启动后降级实时通知，以及覆盖 registry、恢复路径和真实 PRF authenticator 的浏览器 E2E 前，加密原语保持未启用。这可防止不完整的存储路径静默创建或接管用户数据。

## Alternatives considered

**把 `CryptoKey` 与密文一起存入 IndexedDB。** 同源数据库读取方会同时得到密文和解密所需密钥。不可导出只能限制 JavaScript 导出密钥，不能阻止源站脚本调用 `subtle.decrypt`，因此无法提供所需的静态数据隔离。

**把本地 profile 存入 Slark 源站。** DSH Worker 无法读取另一源站的 IndexedDB，让 Slark 持有数据还会使本地数据生命周期依赖可选账号层。存储归 DSH 源站所有；跨源集成只传递用户明确选择的模式和连接移交信息。

**打开本地 DSH 前要求云端 bootstrap。** 这会重新产生同一类故障：登录过期、缺邮箱 binding、云端准备、容量或账号 allowlist 都会禁用可用的本地 runtime。在线服务只作为可选能力加入。

**允许多标签页并用 last-write-wins 合并。** Session log、原子文件替换、rename 与硬链接不存在同一套安全合并规则。一个独占写入者会拒绝第二个标签页，不会静默丢失任一标签页的工作。

**持久化完整挂载镜像。** Runtime code 与配置由部署方拥有，可在升级时替换。持久化它们会混合可执行状态和用户数据、扩大迁移范围，并允许存储代码遮蔽签名镜像。

## Consequences

浏览器 runtime 可以在没有 Slark session 时恢复加密本地用户数据；持久化能力不可用时，只降级持久性，不会变成账号或个人工作台错误。严格 namespace、规范路径和认证元数据让跨环境复用、路径穿越和元数据篡改 fail closed。单写入规则牺牲了同一 profile 的多标签页同时编辑。用户可以通过任一已配置 wrapper 解锁随机数据密钥，并能在不依赖云账号的情况下通过受认证恢复包迁移完整加密 profile。单元测试覆盖双密钥包装、恢复包往返与拒绝路径、严格解析与 registry 记录、环境隔离、存储降级、加锁、加密恢复、元数据篡改、有序删除和硬链接身份；构建后的 preview 冒烟覆盖未改变的 session-only 启动路径。
