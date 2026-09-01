# Agent Note：将移动审批绑定到用户看到的操作快照

状态：已实现

[English](2026-08-31-mobile-approval-snapshot.md) | 中文

## 问题

只有 Host 提供完整结构化上下文时，Slark iOS 才能安全允许 DSH 操作。旧审批 frame 只有工具名和可选原因，无法把用户决定绑定到工作目录与展示动作。

## 决策

Host 从不可变 `tool/call` 事件及其已注册 presenter 推导有界 v2 快照，包含工作目录、动作、影响、五分钟过期时间和进程密钥 HMAC 摘要。移动端 allow 必须在过期前回显摘要；reject 不要求摘要。缺少 call id、presenter、cwd 或完整有界投影的调用保持旧版、仅可拒绝的 frame。

已认证的 Slark 本机 descriptor 声明 `slark_mobile_approval_v2`。Slark 探测当前注册，因此 daemon 在线本身不代表支持审批。

## 后果

重连重放保留原待处理快照和摘要。Host 重启会让所有待处理请求及进程密钥失效。快照只包含展示数据，绝不导出原始工具参数。

## 备选方案

- 拒绝发送原始参数，因为 presenter 是现有脱敏与展示边界。
- 拒绝只信任 rpc/session id，因为它没有把用户所见操作进行密码学绑定。
- 拒绝隐藏不完整审批，因为用户必须保留安全拒绝路径。
