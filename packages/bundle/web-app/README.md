---
description: "The browser GUI for dsh: interactive chat, model and settings management, and session history, for users running the dsh web surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

English | [中文](README.zh.md)

Desktop analytics follows the [product collection policy](../../client/product-analytics/README.md), including its live application setting. Web usage is excluded.

Desktop analytics schedules partial batches every 30 seconds, with a 15-second exporter timeout and a 20-second processor timeout. Shutdown allows 2 seconds to drain, then cancels pending requests and retry waits so telemetry does not keep the Host alive. Pending events may be lost on exit.

## Summary

Run `dsh --profile web` to open an interactive browser GUI with chat, model and settings management, and session history. It uses the same model access, tools, and safety defaults as other dsh surfaces. Startup prints an authenticated URL and normally opens it in the default browser; SSH sessions and `--no-open` leave the URL for manual opening. You can change the port and allow extra hosts, but cannot bind all network interfaces. Choose this package for interactive browser work; use `dsh-headless` for one-shot command-line tasks.


## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>

## Use this package

Start the GUI, open your browser, and start talking to the agent. The flags fine-tune the invocation.

### Starting the Web GUI

```sh
dsh --profile web
dsh --profile web --no-open --port 8080
```

After startup you see a `dsh web:` line whose root URL carries a fresh process token. Unless `--no-open` or an SSH session suppresses it, the default browser opens that URL, receives a signed cookie, and redirects to the same directory without the token. You know it worked when the page loads and you can chat with the agent. Two failures to expect: if the frontend is not built, startup stops with a build hint (`pnpm run build` in a checkout); if the browser cannot be opened, a credential-free diagnostic prints to stderr while the server keeps running — open the printed startup URL yourself.

**Settings → Models** displays **DeepSeek**, using `DEEPSEEK_API_KEY`. The default is `deepseek-official` / `deepseek-flash` (DeepSeek-V41-Flash). The [DeepSeek plugin](../../llm/llm-deepseek/README.md#endpoint-and-wire-format) uses the Messages API.

Saved model selections override the composition default. The settings card accepts a Messages-compatible API address and a credential reference.

### Configuration

Most users never set these; the command-line flags feed the four settings below — `--host`, `--port`, and `--trusted-host` come from the invocation, and `--no-open` turns the browser handoff off for that invocation:

| Field | Default | Meaning |
|---|---|---|
| `openBrowser` | `true` | Open the default browser after startup; SSH launches suppress it |
| `printUrl` | `true` | Print the `dsh web:` URL line at startup |
| `surfaceContext` | `true` | Give the agent GUI-orientation context and expose `DSH_WEB_URL` to its shell commands |
| `trustedHosts` | `[]` | Extra hosts allowed to reach the GUI from the network |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) is the exhaustive source for every accepted field and its JSDoc. The shipped composition carries no `time-context`, `schedule`, or `ui-schedule` row; the optional experimental bundle `@deepseek-ai/dsh-experimental-schedule-bundle` inserts those three rows from the Plugins page.

### LAN access and trusted hosts

By default the GUI accepts connections from this machine only. A deployment that binds all network interfaces also allows browsers from the LAN, and the printed URL then includes a LAN address; `--trusted-host` adds extra hosts in either case. Host and Origin checks control reachability, while the token exchange authenticates every Host API method and WebSocket stream. The LAN addresses are sampled once at startup, so a network change later is not picked up — restart the GUI to re-advertise.

### Running over SSH

When you launch `dsh --profile web` over SSH, the URL line still prints but the browser is not opened for you: the SSH client or editor owns the local forwarding address. Open the forwarded URL on your machine yourself; the printed URL names the remote host's loopback endpoint.

### Per-session agent setup

Each browser session selects a shipped preset (`standard` by default). The Agent presets settings page changes the default and edits preset child plugins; saves persist in `$DSH_HOME/profiles/web/cordis.patch.yml`. Creator's plugin-management tool is enabled only when the Host provides an editable profile.

-----

<a id="understand-the-implementation"></a>

## Understand the implementation

`DSH_PROFILE_WORKSPACE_MODEL_TOKEN` enables `/internal/desktop-workspace-model-selection` only inside an isolated Profile worker. The endpoint accepts a 2 KiB registry workspace/Session target and delegates to the Host-only Session Controller reader without activating an Agent or dispatching a model. Browser cookies cannot authorize it. Failures omit exception details; responses are noncacheable and contain only validated selection fields. This read does not provide a Source proof or prepared configuration snapshot.

When an isolated Desktop Profile worker supplies `DSH_PROFILE_MODEL_TOKEN`, the bundle also serves one Host-only local text request. It snapshots the Profile's current default model and uses its credential service for a single user message without tools or a Session. The private token is never returned to the browser; requests are limited to 8 KiB, answers to 16 KiB, and execution to 60 seconds. A separate token-authenticated local route executes bounded Desktop Session commands through the Profile's existing Session Remote methods; browser cookies cannot authorize it. Session history projects only Web-visible message, tool, and turn fields and returns a recent ordered suffix within the Host control-frame budget; internal, older, or oversized records are omitted. A third Host-only route, enabled by `DSH_PROFILE_REMOTE_UI_TOKEN`, accepts exact Session and startup reads through the existing Gateway, with bounded request and response bodies. Startup reads include redacted settings, preset rosters, source-free Plugin inventory, credential status without values, and permission options; credential references are bounded and validated. `dynamicCordisRunner/syncInspectManifest` remains denied because it changes Host state. The boot read returns current structured startup rows, not arbitrary URL content; the browser parent must still authenticate and check resource bytes before executing remote scripts. The same private token also protects a separate `session/follow`, `workspace/follow`, or `$events` NDJSON route; it limits each event to 512 KiB and cancels the Gateway iterator when its Host HTTP reader disconnects. Browser cookies cannot authorize either remote UI route. These are internal building blocks, not a public browser API or a complete remote UI transport; the event stream and writes still require a separately authorized Host lease bridge. `session/collaborationSources` reads the existing owning Session journal without model preparation or task submission. Remote control reads return one complete original message within 60 KiB of JSON, using its immutable snapshot digest for the next page; larger individual messages are refused without truncation. Session Controller retains its ordinary eight-message, 256 KiB feed for local clients.

When the Desktop remote Session route is active, its Profile keeps one control claim per Session. Browser Session writes implicitly claim local control while the Session is unclaimed; a remote controller uses explicit acquire and compare-and-swap takeover. The Profile checks remote claims on every supported mutation and approval reply, checks local browser writes and event replies at the Gateway, and holds admitted writes until they settle. Control claims expire after 30 seconds without renewal and are invalid after Profile restart. The daemon and Slark Server must exchange the Profile claim before the remote browser can use these commands.

When a remote client owns the current Session, the Desktop browser shows a takeover action in the Session header. It reads the current Profile epoch again, asks the user to confirm, and submits a compare-and-swap takeover through the authenticated browser Gateway. The user then resends the retained draft. The action is absent without the Desktop remote Session route.

Remote `session.create` forwards optional Workspace and Session IDs to the selected Profile. The Profile resolves these IDs through its registry and native Session controller; caller-supplied paths do not cross the Host command protocol. A native `session/writer-held` refusal returns a bounded `sessionCreateFailure` value for the remote UI's existing blank-session fallback. Native approval results use the pending `$events` generation and must match its Session ID. An event stream rejects a second ready frame or a client ID already held by a live stream; closing the stream clears its pending approvals.

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch layer of five files plus one runtime glue plugin: `cordis.patch.yml` carries the host rows and the preset registry, and each `presets/<id>.patch.yml` inserts one shipped preset declaration, applied in the order `dsh.bundle.patch` lists them. The storage stack and projection cache come from `dsh-base`; the web overlay's workspace and message-feedback rows consume that shared `storageDomain` service. The patch restates the surface-specific values the base deliberately omits, inserts the web-only host rows and browser roster, then moves the agent plane behind presets. The glue plugin owns dist serving, trust sampling, prompt sections, the bash variable, and the readiness announcements. The `office-to-pdf` row mounts one lazy [Office conversion provider](../../document/office-to-pdf/README.md) for Host consumers, including Desktop compositions using this bundle. The conversion service's Remote methods authorize preview reads, while Document Preview owns the Office viewer and Client cache.

### Patch semantics

A patch replaces the targeted row's whole `config`, so each web row restates every key it owns: the persona prefix and suffix templates, the `DSH_TOOLS_MODE` PTC mode opt-in, and the `session-query-sqlite` values on the base rows, then `insert` adds the web host rows, transport, and browser roster. The per-agent tool rows the base mounts process-wide are disabled here and the preset roster takes over; the reasoning for each host-plane versus preset-plane decision is inline in the patch.

### Readiness

The URL line and browser handoff are readiness signals: supervisors RPC as soon as they observe the line, and a browser requests the page as soon as it opens, so both run only after the Loader tree settles, the required-startup audit passes, and Connection authentication is available — or immediately in a hand-built tree without a Loader. Client combo JavaScript and source maps remain unmaterialized at this point. Optional plugin failures do not suppress readiness; a required startup failure or a tree disposed mid-boot announces nothing.

### LAN trust sampling

`resolveLanTrust` samples the network once at boot: a loopback bind (`127.0.0.1`) derives no LAN addresses, while an all-interfaces bind adds every non-internal IPv4 literal. The derived literals plus the explicit `--trusted-host` authorities form the `/api` browser-trust fence, and the printed LAN URL always matches that fence.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `web-app` glue plugin: dist resolution, LAN trust sampling, prompt sections, bash variable, URL line, browser handoff |
| [`src/startup.ts`](src/startup.ts) | The `web-startup` provider: `--host`, `--port`, `--trusted-host`, `--no-open`, `--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | The web patch: restated base values, web host rows, browser roster, preset registry |
| [`presets/`](presets) | One `@deepseek-ai/dsh-agent-preset` declaration per shipped preset (`standard`, `ptc`, `minimal`, `cordis`), each its own patch file |
| — | No runtime invariant companion is published; every contribution (frontend-static child plugin, prompt section, bashEnv registration) is registry-disposed with the fiber, and each owning registry's package carries that relation's invariant; the package holds no mutable state of its own to audit. |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | Dist resolution, fallback seat, prompt sections, readiness |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |
| [`tests/trusted-hosts.spec.ts`](tests/trusted-hosts.spec.ts) | LAN-trust sampling |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | Default-browser handoff after the page is reachable |

### Invariant ownership

No invariant companion is published because every contribution — the frontend-static child plugin, the prompt sections, and the bash variable registration — is registry-disposed with the fiber, and each owning registry package carries that relation's invariant.

</details>

-----

<a id="further-exploration"></a>

## Further Exploration

Read these pages when you want to go deeper into the shared core, the browser reload pipeline, or the built frontend.

- [Bundle package map](../README.md) — the surfaces built on the same core.
- [dsh-base](../base/README.md) — the shared core the GUI runs on.
- [dsh-client-hmr](../../client/hmr/README.md) — how client-plugin changes reload during development.
- [frontend-static](../../host/frontend-static/README.md) — how the built frontend is served.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>

`DSH_PROFILE_SOURCE_TOKEN` enables `/internal/desktop-collaboration-source` in the isolated Profile worker. Its private POST accepts at most 2 KiB of exact original Source coordinates and returns a validated descriptor of the existing journal entry. It rejects browser-cookie access, caller model/commit fields, missing Sources and lost Session membership. Replies are noncacheable, sanitized and contain no message content or executable call; signing belongs to the parent Native Host.

The same private token additionally enables `/internal/desktop-collaboration-source-snapshot`. Exact coordinates resolve the existing owning Profile journal snapshot, with strict nested metadata and content-digest validation. The reply is a descriptor plus original Source JSON, without credentials or an executable handle. Browser cookies cannot authorize this route; missing membership, malformed journals and read failures return sanitized refusals. The parent consumes the complete bounded response and transfers it through fixed control-protocol chunks.

`DSH_PROFILE_ANALYSIS_TOKEN` separately enables `/internal/desktop-collaboration-analysis` for the Parent Host. `prepare` captures the Profile-owned Source and persists the full analysis input, then waits for a cloud grant without calling the model. `dispatch` resumes that same one-shot call only under its original binding digest and durably saves output before replying. Two pending operations and a 30-second lifetime bound preparation and execution; cancellation, disposal, expired grants and repeats refuse continuation. Browser cookies and Source-read tokens cannot authorize it. This private route grants no task admission and does not expose executable recovery or a Renderer API.

`capture_reply` first persists a mention-free reply Source and retains its process-local call without analysis. After the coordinator commits that reply against the selected pending items, `prepare_clarification` verifies the complete original/reply input with the owning Profile and persists a new manifest before waiting for its matching plan/revision grant. The original Source descriptor remains the analysis identity. Duplicate captures return passive recovery; concurrent preparations, binding changes, expiry and disposal cannot reconstruct or resend the call. These operations share the same two-operation and 30-second limits.

`DSH_PROFILE_DELIVERY_TOKEN` independently enables `/internal/desktop-collaboration-delivery` for the parent Host. It accepts at most 1 MiB of exact readable delivery JSON and delegates original Source and membership checks to the owning Session Controller. It returns a noncacheable first-commit descriptor only after saving the complete reply; the answer is not echoed. Browser cookies, Source-read tokens, caller-supplied commits and restricted projections cannot authorize a save. Cancellation, write failure and post-commit ownership loss withhold a successful receipt without deleting saved data. This route does not sign a cloud acknowledgement or append a chat event.


A separate `DSH_PROFILE_REFERENCE_TOKEN` enables `/internal/desktop-collaboration-reference-capture`. The parent sends at most 32 KiB of already authorized locator/range/recipient selection. A literal quote is accepted only when the Profile returns its resolved UTF-16 range and exact computed quote byte length and digest. Session Controller independently derives and persists the full request from actual content; the response contains at most 32 KiB of computed metadata and no content bytes. Source-read tokens and browser cookies cannot capture references. The trusted parent must establish explicit user sharing intent before calling; natural-language resolution and cloud transfer remain separate.

The same independent Reference token protects `/internal/desktop-collaboration-reference-content`. Its private query contains only original Source coordinates, the committed full reference request digest and a byte offset, within 2 KiB. The Profile rechecks current membership and selected content for every response. Responses contain exact chunks of at most 32 KiB, support empty content and remain noncacheable; Source tokens and browser cookies grant no access. Cloud transfer and task attachment remain coordinator-owned.

The same Source token protects `/internal/desktop-collaboration-reference-grant`. Its private 2 KiB query contains only original Source coordinates and a full reference request digest. The owning Session Controller requires a separately committed selection and independently rechecks its current message or attachment bytes. The sanitized, noncacheable response contains only the Source descriptor and matching digest; browser cookies, caller paths and content cannot authorize it.

### Remote workspace directories

The remote directory chooser runs on the Host display. A selected directory receives a Profile-local confirmation bound to the paired client; `workspace.create` consumes it once within 60 seconds and refuses a different path or client. Cancellation returns no confirmation, and picker confirmations are not journaled. The Host advertises `profile.remote_session.directory_picker` only with the worker command executor installed.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (first-party order 10100, after reusable instructions) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

Source and Web sections follow first-party reusable instructions. Different checkout paths or local ports leave that preceding prefix unchanged when tools and configuration match; provider cache reuse is not guaranteed.


## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits tell you what to expect in unusual setups — a source checkout, SSH sessions, or strict networks. They are current package constraints, not a general browser comparison or a task backlog.

- **The frontend must be built** — a source checkout needs `pnpm run build` first; startup stops with a build hint when the dist is missing, and there is no source-serving fallback.
- **LAN addresses are sampled once at startup** — interface changes after boot are not re-advertised; the printed LAN URL always matches what was sampled.
- **Only the handoff start is observable** — the GUI reports that the browser was asked to open, not that it actually opened; a later browser exit is never reported, and the printed URL is your manual fallback.
- **SSH sessions keep the URL but skip the browser handoff** — the printed URL names the remote host's loopback endpoint; the SSH client or editor must expose and open the local forwarded address.
- **`BROWSER` overrides only come from the environment** — a discovered `.env` cannot set `BROWSER`; only an inherited value can choose the executable for the automatic handoff.
- **Binding all network interfaces is not supported** — `--host 0.0.0.0` is rejected at startup for safety; use the default loopback host.
- **Desktop control groups local browser windows** — the Profile currently treats local browser windows as one Desktop owner. Its claim covers Session Remote mutations and forwarded approval replies; terminal input, file upload, and settings writes have separate owners and are outside this claim.


<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

The Web composition includes the account Remote controller and Account settings section.
