---
description: "Show Slark's existing Desktop Hub from DSH navigation after the active Desktop bridge confirms readiness."
kind: "package-reference"
---
# DSH Client UI Extension Center

English | [中文](README.zh.md)

## Summary

Open Slark's existing Desktop Hub from the DSH sidebar. The entry appears directly above Settings only after the Desktop bridge confirms an active DSH Profile. It preserves the Hub's existing content and leaves plugin lifecycle and configuration to the official DSH Plugins page.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Desktop Web bundle mounts this package's Client entry. No extra configuration is required. On a verified Desktop bridge, select Extension Center above Settings to open the existing Hub. The entry is absent when the bridge is unavailable or its readiness handshake fails.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client entry registers localized sidebar and panel slots only after `hello()` returns the supported bridge protocol. Opening the row selects the backing panel and asks the bridge to show the Hub; a failed open clears the selection. Disposing the plugin removes both slots and the bridge listener.

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as this browser navigation package registers no model-facing input or tool.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The entry depends on Slark's Desktop bridge and is unavailable in a standalone DSH browser session. Plugin installation, activation, and configuration remain on the official DSH Plugins page.

- **Desktop-only entry** — no bridge or failed readiness handshake leaves the navigation row hidden.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
