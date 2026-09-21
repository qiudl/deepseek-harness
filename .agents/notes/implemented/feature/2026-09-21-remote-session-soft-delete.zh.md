# Agent Note: 远程 Session 软删除

Status: implemented

[English](2026-09-21-remote-session-soft-delete.md) | 中文

## 问题

Slark 移动端与 Web Client 需要 `session.delete` 操作，但 Session 日志是 append-only 记录，Host 不提供物理删除原语。若把移动端动词解释为删除日志，会违背持久化保证；若在在线工作结束前确认，则隐藏后的任务仍会继续运行。

## 决策

Session Controller 将 `session.delete` 暴露为用户可见的软删除。它先把已知 Session 加入 Workspace registry 的持久全局归档集，同时保留日志与 Workspace accounting。若 Agent 已挂载，则不保留 inbox 地取消活动工作，并等待 Agent 全部活动进入 idle 后，才返回 `{ deleted: true }`。明确不存在的 Session 映射为 `session/not-found`；存储故障原样传播。

`session.leave` 仍不提供，因为本地 Host 没有可撤销的协作成员关系。远程文件字节继续使用已认证的流式上传路由；控制 Remote 不新增分块附件动词。

## 已考虑的替代方案

**物理删除 Session 日志。** Session persistence 有意不提供删除操作，已提交的 generation 保持不可变。

**只在 Slark adapter 中复用 `workspace.archiveSession`。** 这会使公开移动端操作依赖第二个 Remote namespace，而且不会取消或等待在线 Agent 工作结束。

**通过 `session.attach` 传输附件字节。** 现有上传服务已在 Typert Remote 之外传输字节，并将 Host 签发的 receipt 绑定到精确 Session 与 Agent。复制该路径会增加 relay 内存压力并削弱 scope ownership。

## 结果

已删除 Session 会从 Session 列表、搜索与分组界面消失，但仍可供 persistence、审计与 Workspace accounting 使用。确认可能需要等待提供方取消收敛。归档集使该操作具备幂等性。共享 Session 离开操作需要未来的 membership owner；远程浏览器需要独立的已认证或端到端加密字节传输，之后才能复用 Host 上传 receipt。
