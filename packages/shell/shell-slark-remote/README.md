# @deepseek-ai/dsh-shell-slark-remote

English | [中文](README.zh.md)

Slark Device Agent implementation of the canonical [`ctx.shell`](../shell/README.md) contract. A cloud Harness cell submits path-free Shell tasks to the user's granted local workspace; it never executes a local fallback inside the cell.

```ts ignore-check
import SlarkRemoteShellExecutor from '@deepseek-ai/dsh-shell-slark-remote'

await ctx.plugin(SlarkRemoteShellExecutor, { workspaceHandle: 'opaque-workspace-handle' })
```

## Behavior

- Foreground `run` preserves nonzero exits, timeout/abort classification, bounded stdout and stderr, and the existing Shell tool schemas.
- Background `start` returns a synchronous `ShellProcess` proxy while initialization continues asynchronously. The Device Agent owns the real macOS process group.
- Each proxy polls with a monotonic output cursor. A retained-window gap sets `lossy` and resumes at the Device Agent's `availableFromSeq`; it never reports a truncated stream as complete.
- `snapshot()` returns only `startTaskId`, `opaqueProcessId`, and `afterOutputSeq`. `resumeProcess()` reconstructs polling and kill access after a Runtime Cell restart without starting the command twice.
- Virtual workdirs must remain under `/workspace/<workspaceHandle>`. Device paths, arbitrary environment injection, and local fallback are rejected.

## Model Experience

Indirectly, through `dsh-tool-bash`, which keeps the existing foreground and background tool schemas and renders lossy-output notices through the canonical Shell contract.

#### KV Cache effect

No prompt prefix or tool schema changes. Only virtual workspace coordinates and existing Shell results become model-visible.

## Known Limitations and Deferred Work

- Resume coordinates are exposed for the jobs persistence layer; the deployment preset that persists and restores them is delivered separately.
- Background output is bounded in both the Device Agent and Runtime Cell. A gap is explicit, but no device-local spill path is exposed to the cloud cell.
- Availability depends on an active Slark Desktop/daemon connection and Workspace Grant.
