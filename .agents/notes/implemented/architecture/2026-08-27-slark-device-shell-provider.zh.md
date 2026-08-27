# Slark Device Shell Provider

[English](2026-08-27-slark-device-shell-provider.md) | 中文

## 决策

用 Slark Device Provider 实现不变的 Harness `ShellExecutor` seam。前台命令使用一个持久 Device Task；后台命令使用由不透明进程 ID 寻址的独立 `start`、`poll` 与 `kill` Device Task。

云端代理只持久化 `startTaskId`、`opaqueProcessId` 和最后消费的输出序号，因此 Runtime Cell 重启后可以重建代理，不需要保留进程内存对象，也不会再次发起 start。

## 输出连续性

Device Agent 持有有界、有序的输出窗口。poll 响应携带 `availableFromSeq` 与 `nextOutputSeq`。调用方落后于窗口时，从当前可用边界继续并报告 `lossy`，绝不宣称已经观察到缺失前缀。

## 权限与隐私

每次操作都受选定 workspace handle 与当前 Grant 约束。控制任务必须与 start 权限一致。请求只包含虚拟 POSIX 工作目录，结果不会暴露本机路径或 spill 路径；不存在云端本地回退。
