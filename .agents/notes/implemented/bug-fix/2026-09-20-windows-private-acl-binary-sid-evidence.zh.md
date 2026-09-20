# Agent Note: 从二进制 SID 解码私有路径安全证据

Status: implemented

[English](2026-09-20-windows-private-acl-binary-sid-evidence.md) | 中文

## Problem

Windows Host 注册文件系统适配器此前用 ConvertSecurityDescriptorToStringSecurityDescriptorW 产出的 SDDL 文本来解码句柄派生的安全证据。该 API 会将已知 SID 序列化为别名字符串：在内置 Administrator 账户（RID 500）下，所有者和当前用户 ACE 的受托人都会以 "LA" 形式到达，永远不可能等于调用方的规范 SID 字符串 S-1-5-21-<机器>-500，于是合法的私有目录被拒绝，DSH bootstrap 报告运行时未验证。普通本地账户（任何其他 RID）在 SDDL 文本中保留完整 SID，不受影响，这正是该缺陷只在 RID 500 机器上暴露的原因。

## Decision

适配器改为读取描述符的二进制形式：GetSecurityDescriptorControl 提供 DACL 保护标志，GetSecurityInfo 的所有者和 DACL 指针经 GetAce 枚举，每个受托人 SID 都经 ConvertSidToStringSidW 渲染——该函数总是输出规范数字形式。ACE 类型、标志和掩码直接从 ACE 头读取，因此 SDDL 权限标记表及其别名归一化被整体移除。除 ACCESS_ALLOWED_ACE 和 ACCESS_DENIED_ACE 之外的 ACE 类型一律拒绝该证据；空 DACL 读取为空访问列表，现有的三主体私有检查仍然闭环失败。

## Alternatives considered

**在 SDDL 文本解码器中归一化 "LA" 别名。** 已拒绝：别名到 SID 的映射无法硬编码，"LA" 展开的 S-1-5-21 机器前缀因机器和域而异，文本路径仍需对每个未知受托人做原生往返（ConvertStringSidToSidW 加 ConvertSidToStringSidW）——原生依赖相同，却多保留了一层已经制造过一次别名缺陷的解析层。

**以二进制 SID 与期望 SID 的二进制形式比较受托人。** 已拒绝：改动面更大。证据契约向消费者暴露的是 SID 字符串，且只要两侧都来自 ConvertSidToStringSidW，字符串比较就是精确的。

## Consequences

私有目录准入不再依赖 SDDL 别名行为，RID 500 账户、普通账户以及任何未来可能出现的新别名 SID 的解码结果一致。koffi 绑定面用 GetSecurityDescriptorControl、GetAce 和 ConvertSidToStringSidW 替换了 ConvertSecurityDescriptorToStringSecurityDescriptorW；回归测试以可寻址的原生内存模型（SECURITY_DESCRIPTOR 控制字、ACL 头、内联 ACE SID）取代 SDDL 字符串，并已在 Windows x64 上对照真实 Win32 行为验证。
