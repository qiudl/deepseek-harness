---
description: "Host package map: the Desktop control protocol plus web GUI servers, directory picking, and plugin inventory."
kind: "package-group"
---

# host/ — Host-side packages

English | [中文](README.zh.md)

## Summary

The `host/` group provides the Desktop-to-Host control wire and single-Host authority alongside the web GUI's HTTP and SPA servers, workspace-directory picking seam, and read-only plugin inventory projection. All nine packages are product packages; the browser transport lives in [`client/`](../client/README.md), and the composed application is [`apps/cli`](../../apps/cli/README.md) booting the [`dsh-base` bundle](../bundle/base/cordis.patch.yml) that serves the web app under `apps/web/`. The Desktop Host owns no HTTP listener; the picker backends replace one another behind their shared seam.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Nine packages play Host-side roles; each package README owns its contract and configuration.

| Package | Role | ctx key |
|---|---|---|
| [`webserver/`](webserver/README.md) | Browser HTTP server: named routes, upgrades, index taps, and the fallback seat | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.md) | SPA dist server on the webserver fallback seat | consumes `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.md) | Workspace-directory picking seam: capability contract and error vocabulary | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.md) | Native-OS-chooser backend for operators at the host display | registers `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.md) | In-app directory-browser backend, including for remote clients | registers `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.md) | Host-adaptive chooser that mounts the matching backend at boot | mounts a backend |
| [`plugin-inventory/`](plugin-inventory/README.md) | Read-only projection of current Loader entries | Remote `pluginInventory/list` |
| [`control-protocol/`](control-protocol/README.md) | Strict Desktop-to-single-Host identity negotiation and control frame codec | zero-I/O library |
| [`desktop-host/`](desktop-host/README.md) | Person Profile, session, lease, worker, and authenticated Unix transport authority | Main-only local SDK |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem references for the transport and the workspace records, then the layering decision behind the Web client.

- [HTTP server subsystem](../../docs/subsystems/web-server.md) — the webserver's routes, matching order, and config.
- [Workspace subsystem](../../docs/subsystems/workspace.md) — the workspace records the directory picker feeds.
- [Web config-tree boot and transport layering](../../.agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md) — ownership of the Web transport layers.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
