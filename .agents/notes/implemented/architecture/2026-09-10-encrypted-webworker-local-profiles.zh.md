# Agent Note: 加密的 WebWorker 本地 profile

Status: implemented

[English](2026-09-10-encrypted-webworker-local-profiles.md) | 中文

## Problem

浏览器承载的 Harness 需要持久本地 workspace，且不能把 Slark 登录、邮箱绑定、云端工作台或 Desktop 安装作为前提。WebWorker VFS 原本仅驻留内存，可选 fixture overlay 是静态启动输入，不是用户拥有的存储。持久化明文会让任何能读取源站数据库的主体看到对话和 workspace 文件；把数据密钥与密文放在一起则只有加密形式，没有数据保护。本地 profile 还需要单写入者、严格环境隔离，以及浏览器无法保证持久化时的明确行为。

## Decision

**DSH 源站拥有每个浏览器本地 profile。** 页面创建或解锁 profile，通过 structured clone 把不可导出的 AES-256-GCM 数据密钥传给同源 dedicated Worker。Slark 可以选择模式或移交可选在线连接，但其源站不拥有 profile 数据库或密钥材料。`environmentId` 与 UUID `profileId` 组成存储 namespace，并同时绑定密钥 wrapper、profile key check、Web Lock 和每个文件密文；Staging 与 Production 永不复用 namespace，也不静默回退到另一环境。

**resident passkey 保护随机数据密钥。** 注册要求用户验证并请求 WebAuthn PRF extension。PRF 输出通过 HKDF 派生不可导出的 AES-KW 密钥，由它包装新的 AES-GCM 数据密钥，持久层只保存 wrapper 元数据。WebAuthn 允许注册仅报告支持 PRF 而不返回求值结果，因此遇到这种情况时，注册流程立即为新 credential 请求 assertion。解锁要求调用方给出预期 environment 和 profile 标识、完成用户验证、命中准确 credential，并得到有效 PRF 结果。IndexedDB 永远不接收解包后的密钥。

**持久 VFS 状态是受限的加密 overlay。** Worker 先向 Storage API 请求持久化并取得独占 Web Lock，再打开 IndexedDB。它只镜像 `/dsh/home` 与 `/dsh/workspace` 下的规范路径；runtime module、配置和临时文件仍属于镜像或当前会话。每条文件和目录记录都经过加密，AES-GCM additional data 认证其 namespace、格式版本、路径、类型、mode、修改时间和可选硬链接组。完整硬链接集合在一个 IndexedDB transaction 中提交，并在 Cordis 启动前覆盖到不可变镜像与已选 fixture overlay 之上，恢复为同一个文件身份。

**本地就绪独立于在线就绪。** 未选择 profile、持久存储被拒、数据库不可用或缺少 Web Lock 时返回明确的 `session_only`，内存态 Harness 仍可启动。另一个标签页已打开 profile、密钥无效或 profile 元数据损坏时，以不同原因码 fail closed。write-behind 失败会停止后续镜像并保留当前内存会话。Worker 启动失败和正常销毁都会释放 Web Lock；正常销毁先停止 Cordis tree，再 flush 排队中的 VFS 写入。

**产品启用还依赖恢复与呈现责任方。** preview 不传 `localProfile`。在 DSH 源站提供多 profile registry、恢复口令导出/导入包、首次使用与迁移 UI、启动后降级实时通知，以及使用真实 PRF authenticator 的浏览器 E2E 前，加密原语保持未启用。这可防止不完整的存储路径静默创建或接管用户数据。

## Alternatives considered

**把 `CryptoKey` 与密文一起存入 IndexedDB。** 同源数据库读取方会同时得到密文和解密所需密钥。不可导出只能限制 JavaScript 导出密钥，不能阻止源站脚本调用 `subtle.decrypt`，因此无法提供所需的静态数据隔离。

**把本地 profile 存入 Slark 源站。** DSH Worker 无法读取另一源站的 IndexedDB，让 Slark 持有数据还会使本地数据生命周期依赖可选账号层。存储归 DSH 源站所有；跨源集成只传递用户明确选择的模式和连接移交信息。

**打开本地 DSH 前要求云端 bootstrap。** 这会重新产生同一类故障：登录过期、缺邮箱 binding、云端准备、容量或账号 allowlist 都会禁用可用的本地 runtime。在线服务只作为可选能力加入。

**允许多标签页并用 last-write-wins 合并。** Session log、原子文件替换、rename 与硬链接不存在同一套安全合并规则。一个独占写入者会拒绝第二个标签页，不会静默丢失任一标签页的工作。

**持久化完整挂载镜像。** Runtime code 与配置由部署方拥有，可在升级时替换。持久化它们会混合可执行状态和用户数据、扩大迁移范围，并允许存储代码遮蔽签名镜像。

## Consequences

浏览器 runtime 可以在没有 Slark session 时恢复加密本地用户数据；持久化能力不可用时，只降级持久性，不会变成账号或个人工作台错误。严格 namespace、规范路径和认证元数据让跨环境复用、路径穿越和元数据篡改 fail closed。单写入规则牺牲了同一 profile 的多标签页同时编辑。随机数据密钥只能通过已配置 wrapper 恢复，因此独立恢复 wrapper 和加密导出/导入包完成前，产品启用仍被阻断。单元测试覆盖密钥包装、浏览器错误归一化、严格解析、环境隔离、存储降级、加锁、加密恢复、元数据篡改、有序删除和硬链接身份；构建后的 preview 冒烟覆盖未改变的 session-only 启动路径。
