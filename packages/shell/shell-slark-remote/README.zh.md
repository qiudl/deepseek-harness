# @deepseek-ai/dsh-shell-slark-remote

[English](README.md) | 中文

标准 [`ctx.shell`](../shell/README.zh.md) 契约的 Slark Device Agent 实现。云端 Harness Cell 把不含本机路径的 Shell 任务提交到用户已授权的本机工作区；Cell 内绝不回退到本地执行。

```ts ignore-check
import SlarkRemoteShellExecutor from '@deepseek-ai/dsh-shell-slark-remote'

await ctx.plugin(SlarkRemoteShellExecutor, { workspaceHandle: 'opaque-workspace-handle' })
```

## 行为

- 前台 `run` 保留非零退出、超时/中止分类、有界 stdout/stderr 以及既有 Shell 工具 schema。
- 后台 `start` 同步返回 `ShellProcess` 代理，初始化在后台异步继续；真实 macOS 进程组由 Device Agent 持有。
- 每个代理使用单调输出游标轮询。若落后于保留窗口，会设置 `lossy` 并从 Device Agent 的 `availableFromSeq` 继续，绝不把被截断的输出宣称为完整。
- `snapshot()` 只返回 `startTaskId`、`opaqueProcessId` 和 `afterOutputSeq`；Runtime Cell 重启后，`resumeProcess()` 可恢复 poll/kill，且不会重复启动命令。
- 虚拟工作目录必须位于 `/workspace/<workspaceHandle>` 下。本机路径、任意环境变量注入和本地回退都会被拒绝。

## 模型体验

通过 `dsh-tool-bash` 间接呈现；既有前台/后台工具 schema 保持不变，输出丢失提示继续经标准 Shell 契约渲染。

#### KV Cache 影响

不增加 prompt 前缀或工具 schema。模型只能看到虚拟工作区坐标和既有 Shell 结果。

## 已知限制与后续工作

- 本包已暴露供 jobs 持久化层使用的恢复坐标；负责持久化和自动恢复它们的部署 preset 将单独交付。
- Device Agent 与 Runtime Cell 两侧的后台输出均有上限。gap 会被明确标记，但云端 Cell 不会获得本机 spill 路径。
- 可用性依赖在线的 Slark Desktop/daemon 与有效 Workspace Grant。
