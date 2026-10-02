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

The Web bundle mounts this package without extra configuration. When Desktop enables project scope mode, the composer adds a collapsible Slark collaboration area. Choose multiple Slark project spaces for the current DSH workspace and apply the selection. Cancel discards the draft; an unconfigured workspace selects none, and an ungrouped Session cannot select a scope. Loaded Agent names include their project spaces. The directory is read-only until the v2 executor is connected, so this mode refuses legacy Agent chips and calls. Ordinary chat remains available without opening the area.

In the existing single-target mode, type `@` in Slark Desktop, select an Agent under Slark enterprise Agents, and send a plain-text task or question. The selected chip may appear anywhere in the sentence and displays `Agent · Project space`; the candidate description also shows its enterprise. For example, select Guide in the sentence `Please @Guide · qiu-slark check the login problem`. The task strip displays the result in the originating Session and marks unfinished work as background work after 120 seconds.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client source reads account-bound assignments from the Desktop bridge. Each editor chip retains the assignment, project, Agent, enterprise, and publication version; Slark checks assignment authority again when admitting the invocation. The source claims the complete draft for one structured Agent chip, removes only that chip from the question, and refuses ordinary model serialization. Failed submissions retain the draft and re-adjudicate on retry. New references bind their admission key to the question with Web Crypto SHA-256, so unchanged retries reuse the key and edited questions receive a new key; legacy references retain their original keys and chip text. Missing Web Crypto refuses the submission. The scope projection observes the Workspace Controller's Session membership through an entry-injected snapshot hook. It clears cached data on membership or bridge changes, ignores late reads, and reloads authority after every save attempt. Save conflicts and uncertain responses never replay the draft. Project and Agent pages keep explicit continuation state; a page with no visible projects can still have more items, and unloaded selected spaces remain selected. The Desktop bridge supplies only directory summaries. No companion is published.

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
- **Collaboration 2.0 pending** — workspace project-space selection is connected to the Main scope operation bridge. Source capture, model planning, multiple-target execution, and the durable v2 task history are pending; scope mode never uses the legacy invocation as a fallback.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [workspace project-scope decision](../../../.agents/notes/implemented/feature/2026-10-03-slark-workspace-project-scope.md) records why scope mode closes the legacy entry.

</details>
