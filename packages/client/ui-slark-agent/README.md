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

The Web bundle mounts this package without extra configuration. When Desktop enables project scope mode, the composer adds a collapsible Slark collaboration area. Choose multiple Slark project spaces for the current DSH workspace and apply the selection. Cancel discards the draft; an unconfigured workspace selects none, and an ungrouped Session cannot select a scope. Loaded Agent names include their project spaces. If Main enables v2 submission and the server qualifies the target for independent execution, type `@` in chat, select the Agent, and describe the task in natural language. No open panel, task form or preview confirmation is required for a send. Other entries remain read-only; scope mode refuses legacy Agent chips and calls. Ordinary chat remains available without opening the area.

In the existing single-target mode, type `@` in Slark Desktop, select an Agent under Slark enterprise Agents, and send a plain-text task or question. The selected chip may appear anywhere in the sentence and displays `Agent · Project space`; the candidate description also shows its enterprise. For example, select Guide in the sentence `Please @Guide · qiu-slark check the login problem`. The task strip displays the result in the originating Session and marks unfinished work as background work after 120 seconds.

-----

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client source reads account-bound assignments from the Desktop bridge. Each editor chip retains the assignment, project, Agent, enterprise, and publication version; Slark checks assignment authority again when admitting the invocation. The source claims the complete draft for one structured Agent chip, removes only that chip from the question, and refuses ordinary model serialization. Failed submissions retain the draft and re-adjudicate on retry. New references bind their admission key to the question with Web Crypto SHA-256, so unchanged retries reuse the key and edited questions receive a new key; legacy references retain their original keys and chip text. Missing Web Crypto refuses the submission. The scope projection observes the Workspace Controller's Session membership through an entry-injected snapshot hook. It clears cached data on membership or bridge changes, ignores late reads, and reloads authority after every save attempt. Save conflicts and uncertain responses never replay the draft. Project and Agent pages keep explicit continuation state; a page with no visible projects can still have more items, and unloaded selected spaces remain selected. The Desktop bridge supplies only directory summaries. No companion is published.

Scoped references keep the picked workspace, Session, target, capability digest and one UUID. The complete original draft and UTF-16 chip span go to Main; the page supplies no owner, credential, model or Task ID. Unknown submissions retain their draft and Source identity; editing the text does not mint a replacement Source. Main and Native reject changed content for an already captured identity. A new explicit pick creates a new user request. Workspace/archive/bridge changes and substituted or late responses cannot consume the original draft. Main owns analysis, freezing and admission; acceptance is not execution completion.

The v2 result area reads complete original messages from Native's readonly `session.collaborationSources`, then obtains each Source's authorized results from Main's `collaborationDeliveries`. Its React-free model follows Session membership and Connection generation. Admission events and a three-second poll refresh it automatically; refresh retains user-loaded history pages, and older delivery versions cannot roll known delivery state backward. Restricted reads remove answers and names. Complete plain text results display `Agent · Project space`, with execution and transport delivery states kept separate. This read neither submits work nor signs acknowledgments, and does not certify durable Host result storage.

</details>

-----

<a id="model-experience"></a>

## Model Experience

Indirectly, through Session Controller's original collaboration Source analysis; ordinary chat serialization still refuses Agent chips.

#### KV Cache effect

Session Controller assembles each Source analysis as a separate request. This plugin adds no ordinary Session history prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Agent mentions require the current account's Slark Desktop bridge to report invocation available. Ordinary `@` references remain available when that bridge is absent.

- **Desktop-only directory** — a standalone DSH browser session cannot list or invoke Slark Agents.
- **Single target** — one explicitly selected Agent and a nonempty text question per send; multiple mentions, mixed references, and attachments are refused.
- **Collaboration 2.0 integration pending** — scoped single-target chat submission calls Main's original Source capture, planning and automatic admission. Scope and execution switches default off. Original-Session v2 readonly messages and results are connected; the actual provider/GUI loop, durable Host replies and signed acknowledgments, multiple targets and explicit references still need integration and acceptance; scope mode never uses the legacy invocation as a fallback.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [workspace project-scope decision](../../../.agents/notes/implemented/feature/2026-10-03-slark-workspace-project-scope.md) records why scope mode closes the legacy entry.

</details>
