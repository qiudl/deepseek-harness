# Agent Note: Slark Device Shell 提供方

Status: implemented

[English](2026-08-27-slark-device-shell-provider.md) | 中文

## 问题

Slark 云端组合必须在选定的 Desktop 设备上执行前台与后台 Shell 请求，且不得暴露设备路径，也不得静默回退到 Runtime Cell。后台命令必须在 Cell 重启后继续受控且不能重复执行；同时，Device 的输出保留有界，延迟 poll 可能无法再取得完整前缀。

## 决策

用 Slark Device Provider 实现不变的 Harness `ShellExecutor` seam。前台命令使用一个持久 Device Task；后台命令使用由不透明进程 ID 寻址的独立 `start`、`poll` 与 `kill` Device Task。

云端代理只持久化 `startTaskId`、`opaqueProcessId` 和最后消费的输出序号，因此 Runtime Cell 重启后可以重建代理，不需要保留进程内存对象，也不会再次发起 start。

## 输出连续性

Device Agent 持有有界、有序的输出窗口。poll 响应携带 `availableFromSeq` 与 `nextOutputSeq`。调用方落后于窗口时，从当前可用边界继续并报告 `lossy`，绝不宣称已经观察到缺失前缀。

## 权限与隐私

每次操作都受选定 workspace handle 与当前 Grant 约束。控制任务必须与 start 权限一致。请求只包含虚拟 POSIX 工作目录，结果不会暴露本机路径或 spill 路径；不存在云端本地回退。

## 考虑过的替代方案

**保留 Cell 本地 Shell 回退。** 不采用，因为在 Runtime Cell 中成功执行会操作与所选 Device 不同的文件系统，并违反 Workspace Grant。

**只在 Cell 内存中保留后台进程状态，并在状态丢失后重新启动。** 不采用，因为 Cell 重启后要么无法继续控制正在运行的进程，要么会再次执行命令。持久 Device Task 与进程标识可以恢复控制，而不会重放 `start`。

## 后果

前台与后台 Shell 操作共用 Device 权限与虚拟路径规则。后台控制可以跨 Cell 重启恢复，但调用方落后于有界输出窗口时会收到明确的 `lossy` 结果，而不是缺失的输出前缀。
