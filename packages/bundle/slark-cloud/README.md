# `@deepseek-ai/dsh-slark-cloud`

English | [中文](README.zh.md)

Runtime Cell bundle applied after [`dsh-base`](../base/README.md) and [`dsh-web-app`](../web-app/README.md). It replaces the cell-local filesystem and Shell providers with Slark Device providers, removes the local subprocess and sandbox providers, disables directory picking and Cordis/plugin/preset authoring surfaces, and selects the shipped `slark-cloud` Agent preset.

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
| `DSH_SLARK_REMOTE_PROVIDER_V1=1` | Enables the Device client, identity adapter, remote filesystem, and remote Shell together |
| `SLARK_DSH_GATEWAY_URL` | Exact internal Slark Gateway HTTP(S) origin |
| `SLARK_DSH_SERVICE_TOKEN` | Service bearer used only in Gateway request headers |
| `SLARK_DSH_AUTHORITY_DIRECTORY` | Absolute private directory containing per-session Edge authority documents and `.publication-state` |
| `SLARK_DSH_WORKSPACE_ROOT` | Absolute root of read-only workspace projections |
| `SLARK_DSH_WORKSPACE_HANDLE` | Opaque handle fixed into the current DSH child and shared by identity, filesystem, and Shell providers |
| `SLARK_DSH_ENVIRONMENT_ID` | Slark environment bound into Cell refresh authentication |
| `SLARK_DSH_CELL_ID` | Runtime Cell id bound into its unique refresh key |
| `SLARK_DSH_CELL_REFRESH_KEY` | Canonical per-Cell HMAC key injected through the process environment, not Cordis config |
| `SLARK_DSH_EDGE_REFRESH_URL` | Exact loopback Edge authority-refresh URL |

Any missing or invalid enabled value fails during activation. When `DSH_SLARK_REMOTE_PROVIDER_V1` is absent or not exactly `1`, every remote row stays disabled while every local execution row remains hard-disabled. Existing sessions remain readable through the Web application, but filesystem and Shell tools cannot mount; there is no local fallback.

The Slark Edge must issue the readable `__Host-dsh_csrf` cookie beside the `HttpOnly` session cookie. The served Web client mirrors that token into `x-slark-dsh-csrf` on every API POST; a missing or mismatched token is rejected by the Edge, and standalone DSH requests remain unchanged because they have no such cookie.

The cloud Agent preset retains DSH goals, planning, compaction, skills, subagents, workflows, jobs, Web search, and remote `read`/`write`/`edit`/`bash`. It omits subprocess-backed `glob`/`grep`, persistent terminals, LSP, hooks, and Cordis authoring. User-authored preset discovery and the preset switcher are disabled in this deployment. The CLI keeps this preset in a cloud-only shipped root selected by the presence of the Slark Device provider row, so standalone DSH neither lists it nor changes its local-provider behavior.

The identity adapter registers the selected read-only workspace projection from `.publication-state`. A deployment supervisor replaces the DSH child when that state selects another workspace, while per-session authority refresh rotates short-lived subjects without restarting the child.

`pnpm run verify-slark-cloud-preset` composes the real base, Web, and cloud layers and rejects an active local provider, authoring surface, user preset root, provider-switch mismatch, secret-bearing identity config, or forbidden cloud-preset row. The check runs in CI and hygiene aggregates.

## Model Experience

### Slark cloud persona

#### What the model sees

The `slark-cloud` persona states that file and Shell operations target the selected Slark Desktop device and that Device or Grant failures are final. Existing tool schemas are reused; omitted local-only tools are absent from the catalog.

#### Token effect

One fixed deployment persona replaces the standard persona while the bundle is active. Device identity and authority values add no tokens.

#### KV Cache effect

Prefix-stable while the bundle composition and persona text are unchanged. Device identity and authority changes do not enter the prompt prefix.

## Known Limitations and Deferred Work

- Remote file search has no provider yet. Agents can use the remote Shell for bounded search commands, but `glob` and `grep` remain absent.
- One DSH child fixes one Workspace Grant. Workspace switching requires the Slark supervisor to replace that child.
- This bundle provides configuration and static proof; Edge/Cell process isolation, authority publication, supervisor reload, resource limits, health checks, and draining belong to the Slark deployment task.
