# Agent Note: 原生成员退役回执

Status: implemented

[English](2026-11-06-native-member-retirement.md) | 中文

## Problem

原生退群无法关闭尚未到达的成员。迟到的原始入群请求可以在退群返回 unavailable 后激活该周期。普通退群签名回执不能单独证明从未加入的原始周期已有持久退役围栏。Cloud 恢复必须先取得这一事实，才能开放下一周期。

## Decision

独立私有能力 `profile.native_room_retirement` 关闭原始周期。target 包含既有 challenge nonce、过期时间、binding id 和捕获代次，以及 `join_command_request_id`、`join_command`、`leave_command_request_id`、`leave_command`。命令沿用既有严格 join/leave schema，请求 id 必须不同，room、member、cycle 必须相同。join 保留原 group、project、Agent 和 name。Cloud 绑定选择值只作为回显上下文，不表示 Host 已认证该关系。

由当前 Account 选择唯一真实 Profile。在当前 worker 操作前后检查授权，要求 worker 代次不变，取消或连接替换后不回成功。私有 Profile 请求仅接收完整原 join command，并调用插件 `retireAgent`；Cloud binding、challenge 和命令请求 id 不传入插件。操作不创建 Source、Session 或模型调用。worker 或 Profile 缺失返回 unavailable；方法缺失返回 upgrade_required，不回落普通 leave。

只签署严格 durable left 回执，序号为非负安全整数。proof 使用 schema_version1、purpose native_room_retirement、完整原 target 和既有 Account/Profile/installation/process 授权字段。Ed25519 字节为 `dsh-native-room-retirement/v1\0` 加固定 JSON tuple `[1,purpose,[nonce,expiry,bindingId,generation,joinRequestId,joinCommandTuple,leaveRequestId,leaveCommandTuple],["left",leftRoomSeq],authorityTuple]`；command 和 authority tuple 沿用既有 projection 字段顺序。不签署 conflict、invalid、unavailable 或未知受理结果。Unix client 返回前检查 target 完全相同、当前 peer、Account、过期时间和签名。

复用既有有界 worker-token 请求生命周期、当前 Account 授权和 control frame 限制。独立注册 Profile 私有路由和可选 worker handle，不进入 view lease。结果 parser 保留明确 upgrade_required，拒绝 joined 或无关原生结果。只有专用 callback 存在才声明外层 control 能力。wire codec、client 结果匹配、worker 取消、真实私有路由注册和编译后的 Slark broker 消费者均须有对应测试。

Cloud 另行核验当前 owner/environment 和持久化原 join/leave intent。捕获代次已经结束时仍可用于清理，不能授权新模型调用。Account 或 installation 变化后没有原清理授权则保持 pending。现存储只接受普通 projection proof，后续增量迁移须支持独立 purpose；本能力不得伪造兼容普通 leave proof。旧记录若没有已证完整原 join，须另行设计恢复，不猜名称或身份。

既有 [Account issuer 连续性决定](../../implemented/bug-fix/2026-09-10-account-issuer-profile-continuity.zh.md)继续适用，未被替代。本操作不迁移身份，也不增加其他 Profile 选择方式。

## Alternatives considered

**复用普通 leave proof。** 其严格 target 没有原 join 身份，语义也不承诺缺失成员的围栏。直接扩大语义会让旧消费者误将新保证当作原有保证。

**先重试 join 再 leave。** 会暂时激活已撤销成员，在清理中新增工作，并要求可能已经结束的当前入群授权。

**将 missing 或超时当作已退役。** 两者都不能阻止迟到的已受理 join。只有持久关闭周期的结果才能解除下一周期阻塞。

## Verification

严格 parser 拒绝跨 room/member/cycle 的命令对、重复请求 id、多余字段、accessor、非法字符串和不安全序号。共享确定性 fixture 固定 Host 与 Slark 的签名字节。真实 control、worker 子进程和私有 HTTP 组合覆盖 await 前后当前 Account/worker/peer 核验、缺能力、取消、篡改 proof 及序号0。所属测试套件和选定源码覆盖率独立于 Cloud 业务授权验证本操作；build artifacts/check 验证其编译后导出。

## Consequences

插件可能已经持久关闭，但响应丢失。恢复须保留两个原请求 id 和命令，并重试原身份，不能据此推断不存在或调用模型。独立能力需要 Host、插件和 Cloud 协同升级。它不解决未知历史身份，也不授予跨 Account 或 installation key 变化的清理权。
