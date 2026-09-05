# `@deepseek-ai/dsh-slark-cloud`

English | [中文](README.zh.md)

Runtime Cell bundle applied after [`dsh-base`](../base/README.md) and [`dsh-web-app`](../web-app/README.md). Its independent Web local-computer rollout replaces the legacy Slark filesystem/Shell surface with a versioned file-only Device provider and explicit target selection. Local subprocess and sandbox providers, directory picking, and Cordis/plugin/preset authoring surfaces remain disabled.

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-slark-cloud"
      ]
    }
  }
}
```

## Environment contract

| Variable | Meaning |
|---|---|
| `DSH_SLARK_REMOTE_PROVIDER_V1=1` | Enables the established Slark Device client and legacy v1 filesystem/Shell profile |
| `WEB_DSH_LOCAL_COMPUTER_V1=1` | Independently switches the enabled remote profile to v2 Web file access and target selection; requires the remote-provider switch |
| `SLARK_DSH_GATEWAY_URL` | Exact internal Slark Gateway HTTP(S) origin |
| `SLARK_DSH_SERVICE_TOKEN` | Service bearer used only in Gateway request headers |
| `SLARK_DSH_AUTHORITY_DIRECTORY` | Absolute private directory containing per-session Edge authority documents and `.publication-state` |
| `SLARK_DSH_WORKSPACE_ROOT` | Absolute root of read-only workspace projections |
| `SLARK_DSH_WORKSPACE_HANDLE` | Opaque handle fixed into the current DSH child and shared by identity and filesystem providers |
| `SLARK_DSH_ENVIRONMENT_ID` | Slark environment bound into Cell refresh authentication |
| `SLARK_DSH_CELL_ID` | Runtime Cell id bound into its unique refresh key |
| `SLARK_DSH_CELL_REFRESH_KEY` | Canonical per-Cell HMAC key injected through the process environment, not Cordis config |
| `SLARK_DSH_EDGE_REFRESH_URL` | Exact loopback Edge authority-refresh URL |

When `DSH_SLARK_REMOTE_PROVIDER_V1` is absent or not exactly `1`, every remote row stays disabled while every local execution row remains hard-disabled. When it is `1` and `WEB_DSH_LOCAL_COMPUTER_V1` is absent or `0`, the reviewed legacy v1 filesystem/Shell surface is preserved. Only the exact pair `1`/`1` activates v2 identity, versioned file access, target selection, and the file-only persona; any other Web flag value fails boot, and there is never a cell-local fallback.

The Slark Edge must issue the readable `__Host-dsh_csrf` cookie beside the `HttpOnly` session cookie. The served Web client mirrors that token into `x-slark-dsh-csrf` on unsafe same-origin requests, including target-selection `PUT`; a missing or mismatched token is rejected by the Edge, and standalone DSH requests remain unchanged because they have no such cookie.

With the Web local-computer rollout enabled, the cloud Agent preset retains DSH goals, planning, compaction, skills, subagents, workflows, Web search, and remote `read`/`write`/`edit`, while omitting Shell, jobs, subprocess-backed `glob`/`grep`, persistent terminals, LSP, hooks, and Cordis authoring. With the rollout disabled it retains the reviewed legacy remote Shell/jobs surface. User-authored preset discovery and the preset switcher stay disabled in both modes.

The identity adapter registers the selected read-only workspace projection from `.publication-state`. A deployment supervisor replaces the DSH child when that state selects another workspace, while per-session authority refresh rotates short-lived subjects without restarting the child.

`pnpm run verify-slark-cloud-preset` composes the real base, Web, and cloud layers and rejects an active local provider, authoring surface, user preset root, provider-switch mismatch, secret-bearing identity config, or forbidden cloud-preset row. The check runs in CI and hygiene aggregates.

## Model Experience

### Slark cloud persona

#### What the model sees

The rollout-selected `slark-cloud` persona describes its exact capability surface: v2 says file operations target the explicitly selected Slark Desktop device and that Shell/process execution is unavailable; legacy v1 continues to describe remote file and Shell operations. Device or Grant failures remain final.

#### Token effect

One fixed deployment persona replaces the standard persona while the bundle is active. Device identity and authority values add no tokens.

#### KV Cache effect

Prefix-stable while the bundle composition and persona text are unchanged. Device identity and authority changes do not enter the prompt prefix.

## Known Limitations and Deferred Work

- Remote file search has no provider yet. Shell, `glob`, and `grep` remain absent in the Web profile.
- One DSH child fixes one Workspace Grant. Workspace switching requires the Slark supervisor to replace that child.
- This bundle provides configuration and static proof; Edge/Cell process isolation, authority publication, supervisor reload, resource limits, health checks, and draining belong to the Slark deployment task.
