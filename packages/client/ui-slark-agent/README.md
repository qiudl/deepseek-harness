---
description: "Mention an assigned Slark enterprise Agent from a DSH Session in Slark Desktop and read the task result in that Session."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-slark-agent

English | [中文](README.zh.md)

## Summary

Type `@` in a DSH Session inside Slark Desktop to find assigned enterprise Agents. Select an Agent and send a plain-text question to create a Slark task; its result appears in the same Session. The list requires an online Account Profile and a Desktop bridge that confirms invocation is available.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web bundle mounts this package without extra configuration. Type `@` in Slark Desktop, select an Agent under Slark enterprise Agents, and send a plain-text task or question. The selected chip may appear anywhere in the sentence and displays `Agent · Project space`; the candidate description also shows its enterprise. For example, select Guide in the sentence `Please @Guide · qiu-slark check the login problem`. The task strip displays the result in the originating Session and marks unfinished work as background work after 120 seconds.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client source reads account-bound assignments from the Desktop bridge. Each editor chip retains the assignment, project, Agent, enterprise, and publication version; Slark checks assignment authority again when admitting the invocation. The source claims the complete draft for one structured Agent chip, removes only that chip from the question, and refuses ordinary model serialization. Failed submissions retain the draft and re-adjudicate on retry. New references bind their admission key to the question with Web Crypto SHA-256, so unchanged retries reuse the key and edited questions receive a new key; legacy references retain their original keys and chip text. Missing Web Crypto refuses the submission. The Desktop bridge supplies only directory summaries. No companion is published.

</details>

-----

<a id="model-experience"></a>

## Model Experience

None, as Agent mentions go through the Slark Desktop bridge and do not enter the ordinary DSH model request.

#### KV Cache effect

None; this plugin does not assemble or send a DSH provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Agent mentions require the current account's Slark Desktop bridge to report invocation available. Ordinary `@` references remain available when that bridge is absent.

- **Desktop-only directory** — a standalone DSH browser session cannot list or invoke Slark Agents.
- **Single target** — one explicitly selected Agent and a nonempty text question per send; multiple mentions, mixed references, and attachments are refused.
- **Collaboration 2.0 pending** — this improves the existing single-target entry. Workspace project-space selection and model planning across targets are not connected here; planning failures cannot fall back to this entry.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
