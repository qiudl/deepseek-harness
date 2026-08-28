# `@deepseek-ai/dsh-slark-identity`

English | [中文](README.zh.md)

Slark Edge identity adapter for an isolated DSH Runtime Cell. It binds the [`SlarkDeviceClient`](../../slark/device-client/README.md) authority source, derives the DSH Session id from trusted agent and tool execution events, and reads or refreshes that session's short-lived subject plus Device and Workspace Grant fences without exposing credentials to the browser or model.

## Configuration

| Field | Required | Meaning |
|---|---:|---|
| `authorityDirectory` | yes | Absolute private directory containing one atomically replaced `<sessionId>.json` authority document per DSH Session |
| `workspaceRoot` | yes | Absolute private root containing the selected workspace's read-only local projection |
| `expectedWorkspaceHandle` | yes | Workspace handle fixed into the Runtime Cell's remote filesystem and Shell providers |
| `environmentId` | yes | Slark environment bound into Cell refresh authentication |
| `cellId` | yes | Runtime Cell id bound into its unique refresh key |
| `refreshUrl` | yes | Exact loopback Slark Edge authority-refresh URL |
| `refreshKey` | no | Canonical 32-byte base64url Cell key; omission reads `SLARK_DSH_CELL_REFRESH_KEY` without placing it in Cordis config |
| `refreshBeforeExpiryMs` | no | Refresh window before subject expiry; default 60 seconds, maximum 240 seconds |
| `refreshTimeoutMs` | no | Timeout for one Edge refresh request; default 5 seconds, maximum 30 seconds |
| `maxAuthorityBytes` | no | Maximum authority document bytes; default 64 KiB, hard maximum 256 KiB |

Each document uses exact fields: `protocol_version=1`, `kind=slark-dsh-runtime-authority-v1`, environment, assignment, generation, owner, personal-project, subject-token, computer, workspace handle and alias, Grant, epoch, and expiry facts. The adapter opens the session-specific file with no symlink following, accepts only mode `0600` or writer-owned `0640`, validates every field on every use, and rejects expired or composition-mismatched authority.

Missing or near-expiry authority triggers one body-bound HMAC refresh per session; concurrent callers share that request and then reread the writer-owned file. The Edge response contains only workspace metadata and expiry, never the subject token. Refresh failure, malformed publication, or a file that remains missing makes remote execution unavailable.

`runForSession(sessionId, operation)` scopes trusted non-tool work explicitly. The built-in `tools/execute` and `agent/pre-step` listeners apply the same scope automatically, including asynchronous background work descended from those operations. Calling the Device client without either scope fails with `identity_unavailable`.

At activation the adapter validates `.publication-state`, registers the selected read-only projection in the workspace registry under its Slark alias, and removes stale Slark-managed registrations. The Runtime Cell supervisor starts a new DSH child with the published workspace handle whenever the selected Grant changes, so provider configuration and workspace registration change together.

## Model Experience

None, as the adapter keeps Slark identity out of model requests and session logs while provider failures expose only stable errors.

#### KV Cache effect

None. Identity facts stay outside model requests and session logs.

## Known Limitations and Deferred Work

- One DSH child fixes one `expectedWorkspaceHandle`. Selecting another Workspace Grant requires the deployment supervisor to replace that child; changing only a session authority file cannot rebind providers.
- Edge deployment, per-Cell refresh keys, atomic authority publication, and supervisor reload belong to the Slark deployment layer. Loading this adapter without those controls fails closed.
- A trusted direct provider consumer outside tool execution or pre-step processing must call `runForSession`; there is no ambient process-wide fallback identity.
