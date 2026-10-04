# Agent Note: Slark 工作区项目范围

Status: implemented

[English](2026-10-03-slark-workspace-project-scope.md) | 中文

## 问题

REQ-20260930-0004，项目212，T21 /22661。可选协同区域编辑会话实际 DSH 工作区的 Slark 项目限制，与任务发送分开。工作区初始没有项目，未归属工作区的会话不继承范围。

## 决策

范围模式关闭旧分配目录和旧调用入口；新项目范围不授权旧接口。Main 的范围和执行开关默认关闭。只有 Main 启用新版提交，且服务端确认目标支持独立执行时，范围内 Agent 才能作为候选选择；其他目录项仅供查看。普通聊天和已有任务历史仍可使用。

范围数据归属无 React 的会话投影，通过 slot 的 hooks 区域观察。工作区归属来自 Workspace Controller，未保存的选择属于组件私有状态；账号和 Native 权威保留在 Desktop Main。迟到读取不能恢复上一工作区或桥接身份的数据。保存使用当前权威版本，每次尝试后重新读取范围，不自动重放。

## 影响

明确的范围芯片将整条原始消息和 UTF-16 提及位置传给 Main，无需任务表单或确认预览。选择时的工作区、会话、目标、能力摘要与 UUID 绑定 Source。发送结果不确定时保留草稿和身份；编辑文字不会生成替代 Source，重新明确选择才建立新请求。Main 负责原始 Source 捕获、分析、冻结和受理；Client 只接收原始坐标与受理状态。受理不等于执行完成，原会话新版只读结果区域已接入；Host 持久回复与签名回执仍待完成。

新版结果区域通过 Native 分页枚举已保存原文，再经 Main 获取该 Source 的只读授权结果。归属或 Connection generation 改变会清空页面数据；已加载历史页在刷新后保留。受限响应移除答案与目标名称，较旧投递版本不会回退已知状态。读取不签名确认，也不创建普通聊天轮次。

## 考虑过的替代方案

只过滤旧分配列表而保留旧调用，会让缓存芯片或另一 renderer 调用绕过新项目限制，因此范围模式使用自己的当前权限目录和提交入口。

## 测试

验证覆盖模型生命周期、续页、组件多选/应用/取消，以及使用 Desktop 传输 fixture 的构建 AppWebEntry 组合。Native 签名、Main HTTP 协调和受限 PostgreSQL 在 Slark 的专用集成测试中验证；Profile-worker 归属读取、daemon inspection、Slark 认证和 Electron IPC 在该组合中仍为外部 fixture，不构成安装包或生产验收。

YAML 加载的来源与真实 SessionInputShell 覆盖范围候选选择、完整 Source 提交、同一身份的主动重试、工作区/归档/桥接变化、传输丢失，以及迟到或错误来源的受理响应。这些 Client 测试中的 Desktop 传输是 fixture，真实 Provider、工具与 GUI 闭环仍需验收。

真实 YAML 注册、SessionInputShell 受理事件与结果模型联动已覆盖；完整 128 KiB 纯文本结果通过 React DOM 验证。Native 冷 Profile 测试读回原始 journal 并验证分页和归属拒绝；它们仍使用服务端/Provider 替身，不证明实际模型或已安装 GUI 闭环。
