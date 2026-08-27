# @deepseek-ai/dsh-fs-slark-remote

English | [中文](README.zh.md)

Slark Device Agent implementation of the [`ctx.fs`](../fs/README.md) provider contract. It projects one granted local directory as `/workspace/<workspaceHandle>` inside a cloud Harness cell while keeping the device's real path private.

```ts ignore-check
import SlarkRemoteFileSystem from '@deepseek-ai/dsh-fs-slark-remote'

await ctx.plugin(SlarkRemoteFileSystem, { workspaceHandle: 'opaque-workspace-handle' })
```

## Behavior

- All model and process coordinates are normalized POSIX paths beneath the virtual workspace root. Absolute paths outside that root, `..` escapes, backslashes, control characters, oversized paths, and Device staging segments fail with `FS_SANDBOX_DENIED` before a task is created.
- `resolve`, metadata, and listings validate exact remote result shapes. Returned targets preserve opaque Device identity, expose only virtual display paths, and never reveal the selected macOS or Windows directory.
- Text and byte reads use bounded base64 pages. Every later page carries the first page's version, so a concurrent change fails with `FS_STALE_VERSION`; UTF-8 decoding spans page boundaries, while invalid UTF-8 and NUL-byte samples fail with `FS_NOT_TEXT`.
- `writeText` and `editText` preserve the base `FileSystem` contract: guarded and unconditional mutations remain distinct. Each mutation receives a fresh side-effect fence, while ambiguous Gateway retries reuse the same logical Device Task.
- The provider reports `workspace-write` because the Device Workspace Grant confines every mutation. It never falls back to `fs-local` when the device, Grant, or network is unavailable.

## Model Experience

Indirectly, through `dsh-tool-fs`, which keeps the existing `read`, `write`, and `edit` schemas and renders only `/workspace/<workspaceHandle>/...` paths.

#### KV Cache effect

Only the virtual workspace path can appear in tool results; no new tool schema or prompt prefix is introduced.

## Known Limitations and Deferred Work

- Search tools remain subprocess-backed. A cloud composition must mount the matching remote shell provider before exposing `glob` or `grep`; this filesystem package does not add a search RPC.
- Full-file edits still obey the Device Agent's bounded payload and result limits. Large deliverables use artifacts.
- Availability depends on an active Slark Desktop/daemon connection and Workspace Grant; an offline device is an explicit remote I/O failure.
