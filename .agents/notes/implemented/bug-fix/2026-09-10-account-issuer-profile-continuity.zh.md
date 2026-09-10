# Agent Note：Account issuer 的 Profile 连续性

状态：已实现

[English](2026-09-10-account-issuer-profile-continuity.md) | 中文

## 问题

拆分 staging 与 production DSH Account issuer 会改变已有 staging 用户的设备密钥 person index。环境 binding 仍指向同一已授权 workspace，但若 registry 把替代 issuer 当成无关人员，请求会被拒绝，会话、插件、设置与运行时升级状态都会留在无法访问的 Profile 中。

Desktop 还必须区分 legacy session 与从未存在 Account 历史。把当前配置的 issuer 当成已存凭据的 issuer，会让旧 Profile 被新建的本地 Profile 遮蔽；在当前环境使用该凭据则会跨越 Account 信任域。

## 决策

当请求证明全部连续性事实时，`ProfileRegistry.registerAccount` 会原子替换 Account Profile 的 person index：同一 authority environment 与 binding handle 已拥有该 Profile，binding version 严格递增，Keychain handle 不变，unlock material 通过常量时间匹配，没有 Profile 已拥有替代 person index，并且 Host 已验证替代身份的 Account token。Profile id、目录、会话、插件、设置与运行时状态均保持不变。提交后，原 person index 不再可解析。

Slark 从加密保存的 Host-audience token 中取得 session issuer，只用于恢复检测。若 session issuer 与当前环境不同，它仍作为恢复标记，但不能在当前环境授权请求或执行 refresh。当前 staging Account 完成验证后，Slark 会为同一 subject 采用唯一匹配的 legacy production handle；handle 冲突时 fail closed。随后，更高的服务端 binding version 授权 Host 原子替换 issuer。

## Alternatives considered

**Account 恢复失败后创建或打开本地 Profile。** 这会让完整数据看起来像已被删除，并使重复重试产生更多无关 Profile。

**在当前环境使用 legacy Account token。** Production 与 staging 是独立信任域，一个 issuer 的凭据不能授权另一个 issuer。

**把 Profile 目录复制到替代身份。** 文件复制无法保持 Host registry generation、selector、lease 或事务迁移语义，还可能产生部分状态或重复状态。

**允许相同 binding version 替换 issuer。** Legacy 凭据可能把 Profile 再旋转回去。严格递增的服务端 version 使权威身份转换保持单调。

## 后果

完成 issuer 拆分的环境可能需要一次当前 Account 验证，以及服务端签发的更高 binding version。恢复不会覆盖 Profile 内容，也不会复用 issuer 不匹配的凭据。若服务端不提升 binding version，Host 返回 `stale` 并保持原 Profile 不变。

聚焦的 registry 与 authenticated Unix transport 测试固定替换前后 Profile id 不变，并拒绝相同 version、不同 Keychain handle 与错误 unlock material。Desktop 测试固定 local fallback 之前的 legacy issuer 检测、跨环境凭据拒绝与 legacy handle 采用。
