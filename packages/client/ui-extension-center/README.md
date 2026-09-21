---
description: "DSH-native Extension Center main panel and sidebar entry, exposed only after a restricted Slark Desktop Profile handshake."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-extension-center

English | [中文](README.zh.md)

## Summary

The Extension Center is a DSH navigation destination for Plugins, MCP, and Skills. Its entry sits immediately above Settings and opens a root-scoped DSH main panel without replacing or unmounting the current Conversation. The entire contribution stays absent until the restricted Slark Desktop bridge confirms that the renderer belongs to an active DSH Profile.

## Table of Contents

- [Use the Extension Center](#use-the-extension-center)
- [Understand the boundary](#understand-the-boundary)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-the-extension-center"></a>
## Use the Extension Center

In a verified Slark Desktop DSH Profile view, select **Extension Center** above **Settings**. The panel opens on Plugins by default and remembers the last selected Plugins, MCP, or Skills tab independently for each opaque Profile key. Each tab reads its current inventory lazily and presents loading, failure with retry, empty, and ready states. Plugins accept only an exact npm version or GitHub commit. Preparation shows any lifecycle scripts before confirmation; the same form can update to, or explicitly restore, another exact version.

-----

<a id="understand-the-boundary"></a>
## Understand the boundary

<details>
<summary>Implementation internals — click to expand</summary>

The package reads only `window.__SLARK_DSH_EXTENSIONS__`. It never falls back to the general Slark renderer API. Activation calls `hello()` before registering either contribution; a missing bridge, rejected Profile, unsupported protocol, or thrown handshake leaves no main-panel entry and no sidebar row. The successful handshake returns only an opaque preference key and a display label.

The `main` keyed contribution and `sidebar.footer.action` list contribution follow their owners through `ctx.slots.inject()`. The Main-process menu opens the same panel through the bridge's `onOpen()` callback. Every registration and callback is released with the plugin fiber, including a disposal that races an unfinished handshake.

Inventory reads are bound to the selected tab and ignore stale completions after tab changes or unmount. Local storage contains the last tab name and the last opaque operation UUID under the opaque Profile key; it contains no selector, credential, package source, script command, or Host authority. After renderer or worker reload, the UUID reconnects to the durable Host receipt. `unknown` is displayed for manual review and is never replayed automatically.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [ui-layout](../ui-layout/README.md) — root main-panel selection and retained Conversation state.
- [ui-sidebar](../ui-sidebar/README.md) — the footer-action seat above Settings.
- [Slot system](../../../docs/subsystems/slots.md) — contribution ownership and disposal rules.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes Desktop UI and sends no model-facing prompt or tool description.

#### KV Cache effect

None; it does not assemble provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Plugin install, exact-version update/restore and receipt reconnection are available. MCP/Skill mutation controls and plugin enable/remove controls remain deferred; their inventory is already visible.
- A regular browser-hosted DSH page intentionally shows no Extension Center because it cannot prove a Slark Desktop Profile authority.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The bridge is a capability boundary, not a transport convenience. Extend its explicit methods and result codes; do not expose `ipcRenderer`, filesystem paths, profile selectors, or a generic invoke function.

No runtime invariant companion is published because the successful Desktop Profile handshake owns the only activation decision and the package retains no independently observable cross-plugin state.

</details>

**Runtime invariant:** No successful Profile handshake means no Extension Center navigation or panel registration.
