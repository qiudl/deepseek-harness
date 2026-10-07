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

The Web bundle mounts this package without extra configuration. When Desktop enables project scope mode, the composer adds a collapsible Slark collaboration area. Choose multiple Slark project spaces for the current DSH workspace and apply the selection. Cancel discards the draft; an unconfigured workspace selects none, and an ungrouped Session cannot select a scope. Loaded Agent names include their project spaces. If Main enables v2 submission and the server qualifies the target for independent execution, type `@` in chat, select up to ten Agents from those spaces, and describe their tasks in natural language. No open panel, task form or preview confirmation is required for a send. Other entries remain read-only; scope mode refuses legacy Agent chips and calls. Ordinary chat remains available without opening the area.

Scope and execution capabilities are independent. A scope-only bridge registers project management without result polling or Agent submission; the full execution bridge enables those consumers.

In the existing single-target mode, type `@` in Slark Desktop, select an Agent under Slark enterprise Agents, and send a plain-text task or question. The selected chip may appear anywhere in the sentence and displays `Agent · Project space`; the candidate description also shows its enterprise. For example, select Guide in the sentence `Please @Guide · qiu-slark check the login problem`. The task strip displays the result in the originating Session and marks unfinished work as background work after 120 seconds.

In scope mode, an unclear request displays its retained natural-language question beside the composer. Reply in the same input without another Agent chip; this continues the original explicitly mentioned target. The Client discovers pending originals from the current Profile’s complete bounded Session feed, then asks Main for each current plan. The collaboration history also restores these questions without requiring a panel action. It refuses to choose among several unresolved requests. A reply identity binds the original Source, plan, pending items and exact text without the changing plan revision, so the same reply keeps its identity after reload. Only a verified Main acceptance or committed-reply response consumes the reply draft; an unknown outcome retains it. New Agent targets still require an explicit chip.

-----

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client source reads account-bound assignments from the Desktop bridge. Each editor chip retains the assignment, project, Agent, enterprise, and publication version; Slark checks assignment authority again when admitting the invocation. The source claims the complete draft for one structured Agent chip, removes only that chip from the question, and refuses ordinary model serialization. Failed submissions retain the draft and re-adjudicate on retry. New references bind their admission key to the question with Web Crypto SHA-256, so unchanged retries reuse the key and edited questions receive a new key; legacy references retain their original keys and chip text. Missing Web Crypto refuses the submission. Legacy chips with a non-string admission key are refused during reference parsing. The scope projection observes the Workspace Controller's Session membership through an entry-injected snapshot hook. It clears cached data on membership or bridge changes, ignores late reads, and reloads authority after every save attempt. Save conflicts and uncertain responses never replay the draft. Project and Agent pages keep explicit continuation state; a page with no visible projects can still have more items, and unloaded selected spaces remain selected. The Desktop bridge supplies only directory summaries. No companion is published.

Directory reads require scope and an available execution or root-planning mode before and after the response. Each scoped reference keeps the picked workspace, Session, target, capability digest and one UUID. The first pick establishes a shared original Source identity, which subsequent chips retain even when the first chip is moved or removed. Each chip carries its own mention ID and UTF-16 span. The complete original draft goes to Main; the page supplies no owner, credential, model or Task ID. Unknown submissions retain their draft and Source identity; editing the text does not mint a replacement Source. Main and Native reject changed content for an already captured identity. Once no scoped chips remain, a new explicit pick establishes a new user request. Workspace/archive/bridge changes and substituted or late responses cannot consume the original draft. Main owns analysis, freezing and admission; acceptance is not execution completion. A verified discussion route sends the unchanged original text through the current ordinary Session prompt with a stable Source-derived request ID. Unknown replies retain the draft; retries use the same identity. Agent chips remain unavailable to ordinary serialization.

In root planning mode, the composer accepts only `planning_recorded` with the original Source and valid root/trace IDs. It displays the trace ID with “Plan saved; execution has not started” and emits no execution-admission event. Uncertain or mismatched replies preserve the draft and original Source identity.

The v2 result area reads complete original messages from Native's readonly `session.collaborationSources`, then obtains each Source's authorized results from Main's `collaborationDeliveries`. Its React-free model follows Session membership and Connection generation; only one readonly query runs per Session. Admission events and a three-second poll refresh it automatically; refresh retains user-loaded history pages, and older delivery versions cannot roll known delivery state backward. History paging stays disabled while a message or result page is being read. Restricted reads remove answers and names. Complete plain text results display `Agent · Project space`, with execution and transport delivery states kept separate. Without replies or clarification questions, the area displays the current verified planning state, including failure, cancellation and discussion. A failed plan read clears that state; a frozen plan alone does not establish execution or acceptance. This read neither submits work nor signs acknowledgments, and does not certify durable Host result storage.

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
- **Text-only scope submission** — scope mode accepts up to ten explicitly selected Slark Agent chips and a nonempty text question per send; mixed references, attachments and repeated chip identities are refused. Legacy mode accepts one Agent.
- **Collaboration 2.0 integration pending** — scope, execution and root-planning switches default off. Root planning preserves the original Source and trace, and concrete tasks require Main-owned preview and confirmation. Original-Session result reads are connected. Actual provider/GUI acceptance, authorized continuation, signed consumption receipts and explicit references remain pending; scope mode never falls back to legacy invocation.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [workspace project-scope decision](../../../.agents/notes/implemented/feature/2026-10-03-slark-workspace-project-scope.md) records why scope mode closes the legacy entry.

</details>

Scoped references picked in root-planning mode retain `submission_mode: planning` in the draft. When new planning closes, submitting that retained draft calls only Desktop `collaborationRecover`, even if legacy execution remains enabled. Missing recovery support or an uncertain/mismatched planning receipt preserves the draft; no ordinary chat or legacy execution is started. This path recovers locally acknowledged roots; it does not browse prior roots after a successful draft has been cleared.

In root-planning mode, the original-message result area can preview concrete frozen tasks through Desktop Main. Previewing does not execute work. Confirming a displayed task submits its Main-retained selection; an uncertain response offers a status check without readmission. The original Trace ID remains visible. Account, window, workspace or Connection changes discard old view state, and Main expires previews after five minutes. A disabled environment permits preview only. Acceptance, execution completion and original-Session consumption remain separate facts.

For a displayed reply whose task is in the Main-owned preview, the result dock offers continuation in the original Session and a separate status check. Only explicit continuation requests a fresh consumer grant; refresh and status checks do not wake an Agent. Unknown outcomes disable another continuation request. The UI distinguishes persisted context consumption from an observed assistant follow-up; neither label completes the root task.

In the original Session’s Trajectory tab, Slark collaboration history reads the Main-recovered root and displays its Trace ID, revision, root state and ordered cloud audit events. Opening history never admits execution or consumes a result. Terminal execution records can expand persisted runtime observations, including tool and file operations; provider internals remain explicitly unobservable. Root completion, execution completion, delivery and consumption retain separate labels. Reloading restores original Sources and rereads authorized history; workspace, Account or Connection changes discard cached records. A denied read removes the affected Source’s cloud details. History is paged, bounded and marked partial because audit coverage cannot certify every provider or continuation step.

An original collaboration Source keeps the Conversation shell active even before ordinary chat starts, so its Trajectory tab remains reachable. The model releases this activity when its Source history is cleared or the plugin is disposed.

The [collaboration trajectory decision](../../../.agents/notes/implemented/feature/2026-10-07-slark-collaboration-trajectory.md) describes readonly history and external shell activity.

The Trajectory tab labels `assistant_message_committed` as a reply committed in the original conversation. It keeps partial coverage and the independently reported root state; this observation does not mark the entire task complete.
