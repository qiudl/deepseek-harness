# `@deepseek-ai/dsh-slark-identity`

English | [中文](README.zh.md)

Slark Edge identity adapter for an isolated DSH Runtime Cell. It binds the [`SlarkDeviceClient`](../../slark/device-client/README.md) authority source, derives the DSH Session id from trusted agent and tool execution events, and reads the current subject token plus Device and Workspace Grant fences from an Edge-owned JSON file for every remote operation.

## Configuration

| Field | Required | Meaning |
|---|---:|---|
| `authorityFile` | yes | Absolute path to the atomically replaced Edge authority document; the adapter refuses symlinks, non-regular files, group/world permissions, empty files, and oversized files |
| `expectedWorkspaceHandle` | yes | Workspace handle fixed into the Runtime Cell's remote filesystem and Shell providers |
| `maxAuthorityBytes` | no | Maximum authority document bytes; default 64 KiB, hard maximum 256 KiB |

The document uses exact fields: `protocol_version=1`, `kind=slark-dsh-runtime-authority-v1`, environment, assignment, generation, owner, personal-project, subject-token, computer, workspace, Grant, epoch, and expiry facts. The adapter validates the complete document on every use, rejects expired subjects, and rejects a workspace handle that differs from the provider composition. The Edge must publish updates by atomic replacement with mode `0600` or stricter; a partially written or permissive document makes remote execution unavailable.

`runForSession(sessionId, operation)` scopes trusted non-tool work explicitly. The built-in `tools/execute` and `agent/pre-step` listeners apply the same scope automatically, including asynchronous background work descended from those operations. Calling the Device client without either scope fails with `identity_unavailable`.

## Model Experience

This package adds no tool, prompt section, or model-visible identity value. Remote filesystem and Shell failures expose stable provider errors without subject tokens or Slark account fields.

#### KV Cache effect

None. Identity facts stay outside model requests and session logs.

## Known Limitations and Deferred Work

- One Runtime Cell boot fixes one `expectedWorkspaceHandle`. Selecting another Workspace Grant requires a new or recomposed cell; authority-file replacement alone cannot rebind providers.
- Edge deployment and atomic authority publication belong to the Slark deployment layer. Loading this adapter without the injected file fails closed.
- A trusted direct provider consumer outside tool execution or pre-step processing must call `runForSession`; there is no ambient process-wide fallback identity.
