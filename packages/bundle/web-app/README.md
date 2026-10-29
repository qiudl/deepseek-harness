---
description: "The browser GUI for dsh: interactive chat, model and settings management, and session history, for users running the dsh web surface."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

English | [中文](README.zh.md)

Desktop analytics follows the [product collection policy](../../client/product-analytics/README.md), including its live application setting. Web usage is excluded.

Desktop analytics schedules partial batches every 30 seconds, with a 15-second exporter timeout and a 20-second processor timeout. Shutdown allows 2 seconds to drain, then cancels pending requests and retry waits so telemetry does not keep the Host alive. Pending events may be lost on exit.

## Summary

Run `dsh --profile web` for browser chat, model and settings management, and session history, with the same model access, tools, and safety defaults as other dsh surfaces. Startup prints a tokenized URL and normally opens the default browser; SSH sessions and `--no-open` require manual opening. You can change the port, allow extra authorities, bind one concrete local IP, and serve HTTPS from a certificate you supply; wildcard addresses are rejected. Remote access uses an advertised HTTP(S) URL behind a prefix-stripping proxy, listener TLS, or plain HTTP on a non-loopback bind. Use the headless profile for one-shot command-line tasks.


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

**Settings → Models** displays **DeepSeek**, using `DEEPSEEK_API_KEY`. The default is `deepseek-official` / `deepseek-flash` (DeepSeek-V4.1-Flash). The [DeepSeek plugin](../../llm/llm-deepseek/README.md#endpoint-and-wire-format) uses the Messages API.

Saved model selections override the composition default. The settings card accepts a Messages-compatible API address and a credential reference.

### Configuration

`--host` and `--port` configure the listener; `--tls-cert` and `--tls-key` make it serve HTTPS; `--public-url` names the advertised public HTTP(S) root the GUI is reached at behind a prefix-stripping proxy, and `--trusted-host` adds further accepted authorities. All are described under [Listening, trust, and public deployments](#public-deployments), and the `tls` field those flags set is documented with the [carrier's config](../../../docs/subsystems/web-server.md#config):

| Field | Default | Meaning |
|---|---|---|
| `openBrowser` | `true` | Open the default browser after startup; SSH launches suppress it |
| `printUrl` | `true` | Print the `dsh web:` URL line at startup |
| `surfaceContext` | `true` | Give the agent GUI-orientation context and expose `DSH_WEB_URL` to its shell commands |
| `publicUrl` | Unset | Advertised HTTP(S) application root; otherwise announce the bind-address URL |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-app) lists this runtime plugin's accepted fields and their JSDoc. The shipped composition inserts the `schedule` service row and the `ui-schedule` task page row, while the clock reading and the four reminder tools belong to the `standard`, `cordis`, and `ptc` presets. The `tool-subagent` and `tool-subagent-fork` rows in those presets deny the four tools, so a delegated child's scope never lists them.

<a id="public-deployments"></a>
### Listening, trust, and public deployments

By default the GUI listens on loopback and accepts connections from this machine only. Only `--host` changes the listener: it accepts one concrete local IPv4 or IPv6 address, never a wildcard. A non-loopback listener without TLS serves plain HTTP and warns at startup, even when an HTTPS `--public-url` fronts it. The Host/Origin fence accepts the bind IP itself; other non-loopback authorities require `--trusted-host`, so a remote browser reaches the GUI behind a prefix-stripping proxy or through a port-forwarding client that presents a trusted hostname. The launch-token exchange and signed session cookie authenticate every API method and WebSocket stream.

Pass `--tls-cert` and `--tls-key` together to serve HTTPS from the listener instead of plain HTTP. Each names a file resolved against the process working directory: the certificate file holds the full chain and the key file an unencrypted PEM private key. The flags are one setting — supplying only one is a usage error, and supplying neither keeps the plain-HTTP default. Startup fails when a file is missing, unreadable, empty, or not a valid certificate-and-key pair; it never falls back to HTTP. Nothing re-reads the material while the listener runs, so serving a different certificate needs a listener reload or a process restart. DSH issues, renews, and watches nothing: there is no ACME client, no self-signed fallback, and no redirect listener. The browser applies its own trust store and host-name matching, so a certificate the browser does not trust, or one whose subject alternative names miss the authority you open, fails before the page loads. The default port stays 3080, and `--tls-cert`/`--tls-key` do not follow `--public-url`: the listener's certificate covers the authority browsers dial. TLS changes nothing about authority: Connection still authenticates every request and still checks Host/Origin, and the session cookie it mints is `Secure` whenever the receiving listener serves HTTPS.

A container can bind its Pod address and advertise the ingress that fronts it:

```sh
dsh --profile web --no-open --host "$(hostname -i | awk '{print $1}')" --public-url https://app.example/ --trusted-host app.example
```

`hostname -i` may list several addresses; `--host` takes one, so the command selects the first. A zone ID such as `fe80::1%eth0` cannot appear in a URL, so the advertised root drops a redundant loopback zone while a non-loopback zone requires an explicit `--public-url`.

Without `--public-url`, mapped IPv6 loopback binds such as `::ffff:127.0.0.1` advertise their IPv4 form, `127.0.0.1`, so the browser recognizes a local, trustworthy origin. The listener keeps the configured bind address. A dotted-quad IPv6 tail names the address's own low 32 bits, exactly as `listen` reads it, so `::0.0.0.1` is IPv6 loopback and advertises `[::1]`, while `::127.0.0.1` is a non-loopback address, not IPv4 loopback.

`--public-url` advertises the HTTP(S) root browsers use — the printed and opened startup URL, `DSH_WEB_URL`, and the web-surface orientation. Advertisement grants no trust: the browser-visible authority must also be named with `--trusted-host`. The flag configures no listener, routing, or cookie scope, because the proxy owns the external leg: [Publish the Web UI behind a reverse proxy](../../../docs/user/guide/public-deployments.md) lists what such a deployment must provide.

Neither the advertised URL nor the browser-trust fence protects the port itself, so restrict the port to the trusted proxy or network.

The printed URL contains a process credential; share it only with intended users. `printUrl: false` suppresses the line with or without `--public-url`, and the credential never appears in the model context or in `DSH_WEB_URL`.

### Running over SSH

When you launch `dsh --profile web` over SSH, the URL line still prints but the browser is not opened for you: the SSH client or editor owns the local forwarding address. Without an advertised root the printed URL names the remote host's bind-address endpoint — loopback for a loopback bind — which you reach through your forwarding address. With `--public-url` the printed URL is the authenticated advertised root; the browser handoff stays suppressed, because opening a browser on the remote host cannot reach your screen.

### Per-session agent setup

Each browser session selects a shipped preset (`standard` by default). The Agent presets settings page changes the default and edits preset child plugins; saves persist in `$DSH_HOME/profiles/web/cordis.patch.yml`. Creator's plugin-management tool is enabled only when the Host provides an editable profile.

-----

<a id="understand-the-implementation"></a>

## Understand the implementation

`DSH_PROFILE_WORKSPACE_MODEL_TOKEN` enables `/internal/desktop-workspace-model-selection` only inside an isolated Profile worker. The endpoint accepts a 2 KiB registry workspace/Session target and delegates to the Host-only Session Controller reader without activating an Agent or dispatching a model. Browser cookies cannot authorize it. Failures omit exception details; responses are noncacheable and contain only validated selection fields. This read does not provide a Source proof or prepared configuration snapshot.

`DSH_PROFILE_SOURCE_TOKEN` also protects `/internal/desktop-bot-identity`. The exact Bot ID is resolved through the Profile-local optional `dsBotSlarkExternalGroup` service at request time. Missing service or Bot returns absence; only Bot ID, derived actor reference and bounded display name can leave the worker. Browser cookies cannot call this route.

`/internal/desktop-native-room` accepts one room ID under the same worker token and asks the optional Profile-local `dsBotSlarkNativeRoom` service to prepare its Slark bridge Source. The response contains only the room ID and Source coordinates. It rejects a Source in the room Session or with extra fields. Browser cookies cannot call this route.

`/internal/desktop-native-room-operations` uses the same private worker token to call that service's bounded join, message page, acknowledgement, and leave operations. It checks exact command and response fields and returns at most three message lines per page. Browser cookies cannot authorize this route.

`/internal/desktop-native-room-operations` also accepts a bounded `agent-result-chunk` only through the Host's dedicated `profile.native_agent_result` capability. The Host checks the current Account, Slark's signed result ticket, and the live Slark turn before forwarding the chunk to the Profile. The Profile assembles the complete reply, verifies its digest, saves one room result, and publishes one group Session message. A repeated chunk returns the saved receipt.

`DSH_PROFILE_ARCHIVE_TRANSITION_TOKEN` enables a separate parent-only `/internal/desktop-collaboration-archive-transition` POST. It accepts an exact Account/environment/workspace/Session/token tuple and one bounded phase action, then uses the Workspace Registry's serialized durable write. A repeated `stage` returns the token's actual phase. The endpoint does not contact Slark or authorize a browser archive request; the Main or Daemon coordinator must reconcile uncertain writes against the same token.

The same parent-only token protects `/internal/desktop-group-input-fence`. Its exact Slark group challenge is checked before a serialized Workspace Registry write; the response echoes only the persisted Workspace, Session, group ID and version. Mismatched results fail closed. Browser cookies cannot invoke this route, and the route does not activate a cloud group.

The same parent-only token guards `/internal/desktop-collaboration-archive-intent`, which reads an existing original token and phase by exact Account, environment, Workspace and Session. The Registry rejects an owner mismatch and checks membership before returning explicit absence. Browser cookies cannot invoke the lookup.

When an isolated Desktop Profile worker supplies `DSH_PROFILE_MODEL_TOKEN`, the bundle also serves one Host-only local text request. It snapshots the Profile's current default model and uses its credential service for a single user message without tools or a Session. The private token is never returned to the browser; requests are limited to 8 KiB, answers to 16 KiB, and execution to 60 seconds. A separate token-authenticated local route executes bounded Desktop Session commands through the Profile's existing Session Remote methods; browser cookies cannot authorize it. Session history projects only Web-visible message, tool, and turn fields and returns a recent ordered suffix within the Host control-frame budget; internal, older, or oversized records are omitted. A third Host-only route, enabled by `DSH_PROFILE_REMOTE_UI_TOKEN`, accepts exact Session and startup reads through the existing Gateway, with bounded request and response bodies. Startup reads include redacted settings, preset rosters, source-free Plugin inventory, credential status without values, permission options, and `cotTranslation/limits`; credential references are bounded and validated. `cotTranslation/limits` requires empty arguments and returns translation preferences, available providers, and the text limit; it grants no translation or settings-write operation. `dynamicCordisRunner/syncInspectManifest` remains denied because it changes Host state. The boot read returns current structured startup rows, not arbitrary URL content; the browser parent must still authenticate and check resource bytes before executing remote scripts. The same private token also protects a separate `session/follow`, `workspace/follow`, or `$events` NDJSON route; Session follow forwards the native `turnWindow` after validating both positive safe-integer minima and the message limit; it limits each event to 512 KiB, sends private idle heartbeats consumed by the [Host reader](../../host/desktop-host/README.md), and cancels its heartbeat timer and Gateway iterator when that reader disconnects. Browser cookies cannot authorize either remote UI route. These are internal building blocks, not a public browser API or a complete remote UI transport; the event stream and writes still require a separately authorized Host lease bridge. `session/collaborationSources` reads the existing owning Session journal without model preparation or task submission. Remote control reads return one complete original message within 60 KiB of JSON, using its immutable snapshot digest for the next page; larger individual messages are refused without truncation. Session Controller retains its ordinary eight-message, 256 KiB feed for local clients. An explicitly authorized `session/follow` private request may add `itemChunks: true`. It retains complete native events up to 8 MiB, compresses them when smaller, and emits canonical base64url fragments of at most 10 KiB before NDJSON wrapping. Each fragment carries its encoding, byte offset, total packed bytes, and original byte length; the consumer must validate and reconstruct the complete item. Other endpoints and unnegotiated requests retain the original event limit.

The private `bot/chat` read uses the selected Profile's opt-in Bot service to resolve an existing default or explicit Bot and its current own-chat Session. It returns no Bot configuration, secrets or history and performs no bootstrap or send. Missing providers return null; malformed or retargeted replies are refused. The [Host control protocol](../../host/control-protocol/README.md) owns the request limits and capability negotiation.

The private Session bridge also exposes fixed Bot send and receipt commands through the opt-in Bot service. A send holds the expected Session's existing control claim; a receipt can be read without taking over that claim. Stable submission IDs survive transport requests and part rollover. Neither command falls back to a generic Session prompt when the Bot provider is missing. Replies are correlated and validated before leaving the worker; authentication, cancellation and plugin disposal retain their existing owners.

Remote `session/collaborationSources` exact lookup accepts `snapshotDigest` instead of `cursor` and requires exactly one matching original without a continuation. Substituted digests, mixed lookup and pagination, and oversized individual messages reject; lookup retains the existing Gateway authorization.

The Host-only `session/collaborationMembership` read validates up to 50 exact Workspace/Session pairs, invokes the current Profile Session controller, and verifies an equally sized ordered ownership reply before returning it to Main. Browser cookies do not authorize this private worker route.

When the Desktop remote Session route is active, its Profile keeps one control claim per Session. Browser Session writes implicitly claim local control while the Session is unclaimed; a remote controller uses explicit acquire and compare-and-swap takeover. The Profile checks remote claims on every supported mutation and approval reply, checks local browser writes and event replies at the Gateway, and holds admitted writes until they settle. Control claims expire after 30 seconds without renewal and are invalid after Profile restart. The daemon and Slark Server must exchange the Profile claim before the remote browser can use these commands.

The native mobile terminal reuses the Profile's existing terminal Gateway. Environment, shell choices, and terminal lists remain read-only. Create, write, resize, rename, and close require the current Session claim; the Desktop browser's corresponding terminal writes obey the same owner fence. Follow and retain require a one-use, ten-second permit issued under that claim. The Profile checks the owner before opening the original terminal stream and before delivering output; closing the mobile stream releases its attachment without closing the shell.

When a remote client owns the current Session, the Desktop browser shows a takeover action in the Session header. It reads the current Profile epoch again, asks the user to confirm, and submits a compare-and-swap takeover through the authenticated browser Gateway. The user then resends the retained draft. The action is absent without the Desktop remote Session route.

Remote `session.create` forwards optional Workspace and Session IDs to the selected Profile. The Profile resolves these IDs through its registry and native Session controller; caller-supplied paths do not cross the Host command protocol. A native `session/writer-held` refusal returns a bounded `sessionCreateFailure` value for the remote UI's existing blank-session fallback. Native approval results use the pending `$events` generation and must match its Session ID. An event stream rejects a second ready frame or a client ID already held by a live stream; closing the stream clears its pending approvals.

<details>
<summary>Implementation internals — click to expand</summary>

The bundle is one patch layer of five files plus one runtime glue plugin: `cordis.patch.yml` carries the host rows and the preset registry, and each `presets/<id>.patch.yml` inserts one shipped preset declaration, applied in the order `dsh.bundle.patch` lists them. The storage stack and projection cache come from `dsh-base`; the web overlay's workspace and message-feedback rows consume that shared `storageDomain` service. The patch restates the surface-specific values the base deliberately omits, inserts the web-only host rows and browser roster, then moves the agent plane behind presets. The glue plugin owns dist serving, the advertised application URL, the plain-HTTP exposure warning, prompt sections, the bash variable, and the readiness announcements. The `office-to-pdf` row mounts one lazy [Office conversion provider](../../document/office-to-pdf/README.md) for Host consumers, including Desktop compositions using this bundle. The conversion service's Remote methods authorize preview reads, while Document Preview owns the Office viewer and Client cache.

### Patch semantics

A patch replaces the targeted row's whole `config`, so each web row restates every key it owns: the persona prefix template, the `DSH_TOOLS_MODE` PTC mode opt-in, and the `session-query-sqlite` values on the base rows, then `insert` adds the web host rows, transport, and browser roster. The `webserver`, `web-runtime`, and `connection` rows inject the `webStartup` provider and read their invocation values directly; Connection composes its accepted authorities from `ctx.webStartup.trustedHosts`, and the Host/Origin fence accepts the listener's bind IP independently of that list. The per-agent tool rows the base mounts process-wide are disabled here and the preset roster takes over; the reasoning for each host-plane versus preset-plane decision is inline in the patch.

### Advertised application URL

Startup display and browser handoff receive the advertised root with its launch token; the web-surface prompt and `DSH_WEB_URL` receive it clean. The root itself is defined under [Listening, trust, and public deployments](#public-deployments).

### Readiness

The URL line and browser handoff are readiness signals: supervisors RPC as soon as they observe the line, and a browser requests the page as soon as it opens, so both run only after the Loader tree settles, the required-startup audit passes, and Connection authentication is available — or immediately in a hand-built tree without a Loader. Client combo JavaScript and source maps remain unmaterialized at this point. Optional plugin failures do not suppress readiness; a required startup failure or a tree disposed mid-boot announces nothing.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `web-app` glue plugin: dist resolution, advertised application URL, prompt sections, bash variable, URL line, browser handoff |
| [`src/public-url.ts`](src/public-url.ts) | Advertised-root validation and trailing-slash normalization; a leaf module for local imports, not package API |
| [`src/startup.ts`](src/startup.ts) | The `web-startup` provider: `--host`, `--port`, `--tls-cert`, `--tls-key`, `--public-url`, `--trusted-host`, `--no-open`, `--help` |
| [`cordis.patch.yml`](cordis.patch.yml) | The web patch: restated base values, web host rows, browser roster, preset registry |
| [`presets/`](presets) | One `@deepseek-ai/dsh-agent-preset` declaration per shipped preset (`standard`, `ptc`, `minimal`, `cordis`), each its own patch file |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | Dist index anchoring, advertised-URL publication and warnings, prompt sections, readiness publication |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | Command-line parsing over a real Loader tree |
| [`tests/public-url.spec.ts`](tests/public-url.spec.ts) | Advertised-root parsing and normalization |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | Default-browser handoff after the page is reachable |

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

`DSH_PROFILE_ANALYSIS_TOKEN` separately enables `/internal/desktop-collaboration-analysis` for the Parent Host. `prepare` captures the Profile-owned Source and persists the full analysis input, then waits for a cloud grant without calling the model. `dispatch` resumes that same one-shot call only under its original binding digest and durably saves output before replying. Two pending operations bound concurrency; preparation and execution each have a 30-second limit, and cloud admission still uses the original lease; local output preserves evidence without granting admission; cancellation, disposal, expired grants and repeats refuse continuation. Browser cookies and Source-read tokens cannot authorize it. This private route grants no task admission and does not expose executable recovery or a Renderer API.

`read_source_output` reads an ordinary Source’s saved original analysis through the same private token. It verifies current Session membership before and after reading and returns the original descriptor, consumed dispatch, output digest and up to 32 KiB of JSON encoded as base64url. Clarification outputs remain separate. Missing output is explicit; multiple original outputs, changed Source, lost membership, cancellation and disposal reject. Reopening the journal retains evidence even after its lease expires, without preparing a model or authorizing dispatch or cloud admission.

`resume_source` transfers the original unused preparation to the current connection after a missing-output read. It requires the exact original message and mentions, current membership and the same Parent-derived Account/Profile/Host-process identity. The attempt, manifest, model and original 30-second deadline remain unchanged. Old connection dispatch, consumed dispatch, timeout and process restart reject.

`capture_reply` first persists a mention-free reply Source and retains its process-local call without analysis. After the coordinator commits that reply against the selected pending items, `prepare_clarification` verifies the complete original/reply input with the owning Profile and persists a new manifest before waiting for its matching plan/revision grant. The original Source descriptor remains the analysis identity. Duplicate captures return passive recovery; concurrent preparations, binding changes, expiry and disposal cannot reconstruct or resend the call. These operations share the same two-operation and separate 30-second preparation/execution limits.

`DSH_PROFILE_DELIVERY_TOKEN` independently enables `/internal/desktop-collaboration-delivery` for the parent Host. It accepts at most 1 MiB of exact readable delivery JSON and delegates original Source and membership checks to the owning Session Controller. It returns a noncacheable first-commit descriptor only after saving the complete reply; the answer is not echoed. Browser cookies, Source-read tokens, caller-supplied commits and restricted projections cannot authorize a save. Cancellation, write failure and post-commit ownership loss withhold a successful receipt without deleting saved data. This route does not sign a cloud acknowledgement or append a chat event.


A separate `DSH_PROFILE_REFERENCE_TOKEN` enables `/internal/desktop-collaboration-reference-capture`. The parent sends at most 32 KiB of already authorized locator/range/recipient selection. A literal quote is accepted only when the Profile returns its resolved UTF-16 range and exact computed quote byte length and digest. Session Controller independently derives and persists the full request from actual content; the response contains at most 32 KiB of computed metadata and no content bytes. Source-read tokens and browser cookies cannot capture references. The trusted parent must establish explicit user sharing intent before calling; natural-language resolution and cloud transfer remain separate.

The same independent Reference token protects `/internal/desktop-collaboration-reference-content`. Its private query contains only original Source coordinates, the committed full reference request digest and a byte offset, within 2 KiB. The Profile rechecks current membership and selected content for every response. Responses contain exact chunks of at most 32 KiB, support empty content and remain noncacheable; Source tokens and browser cookies grant no access. Cloud transfer and task attachment remain coordinator-owned.

The same Source token protects `/internal/desktop-collaboration-reference-grant`. Its private 2 KiB query contains only original Source coordinates and a full reference request digest. The owning Session Controller requires a separately committed selection and independently rechecks its current message or attachment bytes. The sanitized, noncacheable response contains only the Source descriptor and matching digest; browser cookies, caller paths and content cannot authorize it.

### Remote workspace directories

The remote directory chooser runs on the Host display. A selected directory receives a Profile-local confirmation bound to the paired client; `workspace.create` consumes it once within 60 seconds and refuses a different path or client. Cancellation returns no confirmation, and picker confirmations are not journaled. The Host advertises `profile.remote_session.directory_picker` only with the worker command executor installed.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (first-party order 10100, after reusable instructions) orients the model to the GUI: the advertised application URL (defined under Listening, trust, and public deployments above), the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

Source and Web sections follow first-party reusable instructions. Different checkout paths or application URLs leave that preceding prefix unchanged when tools and configuration match; provider cache reuse is not guaranteed.


## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits tell you what to expect in unusual setups — a source checkout, SSH sessions, or strict networks. They are current package constraints, not a general browser comparison or a task backlog.

- **The frontend must be built** — a source checkout needs `pnpm run build` first; startup stops with a build hint when the dist is missing, and there is no source-serving fallback.
- **TLS is opt-in and unmanaged** — the listener serves HTTPS only when `--tls-cert` and `--tls-key` name a full chain and its unencrypted key; DSH never obtains, renews, or watches certificates, and a changed file needs a listener reload or a process restart. The browser must trust that certificate, its names must cover the authority you open, and the certificate is independent of `--public-url`.
- **Without TLS the external leg is plain HTTP** — protect it with a TLS-terminating proxy, and do not send the launch URL over a network you do not trust.
- **Only the handoff start is observable** — the GUI reports that the browser was asked to open, not that it actually opened; a later browser exit is never reported, and the printed URL is your manual fallback.
- **SSH sessions keep the URL but skip the browser handoff** — without an advertised root the printed URL names the remote host's bind-address endpoint (loopback for a loopback bind); the SSH client or editor must expose and open the local forwarded address.
- **`BROWSER` overrides only come from the environment** — a discovered `.env` cannot set `BROWSER`; only an inherited value can choose the executable for the automatic handoff.
- **Binding all network interfaces is not supported** — `--host 0.0.0.0` is rejected at startup for safety; use a concrete local IPv4 or IPv6 address.
- **Desktop control groups local browser windows** — the Profile currently treats local browser windows as one Desktop owner. Its claim covers Session Remote mutations and forwarded approval replies; terminal input, file upload, and settings writes have separate owners and are outside this claim.


<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

The Web composition includes the account Remote controller and Account settings section.


The private `/internal/desktop-collaboration-root` endpoint reuses the parent-only Source capability to read durable root metadata through `inspectCollaborationRoot`. It accepts exact namespace, command and original source coordinates, rejects browser cookies and mismatched replies, and returns no source text or executable handle. Route disposal removes the handler.

The private `/internal/desktop-root-journal` endpoint requires `DSH_PROFILE_ANALYSIS_TOKEN`, accepts at most 2 KiB of exact read/accept JSON, and returns root metadata without Source content. Browser cookies and `DSH_PROFILE_SOURCE_TOKEN` grant no access. Session Controller validates membership and persists the exact original receipt before success; neither operation captures a new Source or prepares a model.

`prepare_root` uses `captureCollaborationRoot` and retains its first analysis call in the same two-stage owner. The root is persisted before preparation is acknowledged. Responses contain the original root descriptor alongside prepared or recovered Source metadata; recovery never contains an executable attempt. The existing binding, timeout, cancellation and one-dispatch rules also apply to root preparation. Neither root registration nor a saved planning candidate grants task execution.

`capture_root` persists the original text-only Source and Root without opening an analysis journal, committing a planning manifest or starting a model. It retains the original process-local call under the current binding and a 30-second capture deadline. Same-binding repeats return the same descriptor only while that call remains unused. After durable Root admission, `start_captured_root` consumes that still-live call once, starts a separate 30-second preparation deadline and prepares the original planning input; `release_captured_root` discards it without planning. Membership, original input, binding, timeout and disposal checks apply to both operations. Recovery returns passive metadata; it cannot recreate the captured call. Disposal waits for accepted captures to settle. Cloud route selection and task authorization remain parent responsibilities.

`read_root_output` reads an admitted root through current Session/Workspace membership, then joins the saved output to its original durable dispatch record. It rechecks root membership after reading. Missing output is explicit; ambiguous records, changed roots, cancellation and disposal reject. Reopening the journal preserves the original output and grant without preparing or calling a model. Cloud consumers must independently enforce the original lease and fence before committing a candidate.

`recover_root` reads an existing admitted root by namespace and Source coordinates. The original text, mentions and continuation policy must match. It never captures a Source, prepares a model, writes a root or creates dispatch state. Pending or absent roots, changed input, cancellation and lost membership reject; a missing local admission receipt requires separate reconciliation.

`reconcile_root` also reads pending roots for Main to retrieve the original cloud receipt. It applies the same Source, policy and membership checks and never admits the root or prepares a model.

`resume_root` requires an admitted root and the original live preparation under the same Account/Host binding. A reconnect may take over through the Parent-derived Account/Profile/Host-process identity, invalidating the old connection’s dispatch ownership. It returns the same attempt and manifest only while dispatch is unused; it does not prepare a new model call or extend the 30-second deadline. Process restart, timeout, membership loss and a consumed dispatch reject.

Original and recovery analysis owners await sanitized failure persistence before settling a failed model operation. Disposal cancels work and awaits operation settlement before closing journals. Persisted failures remain local read-only observations tied to the original consumed attempt and trace; they do not change private HTTP responses, cloud state, Session logs or replay eligibility.

The analysis-token endpoint owns `prepare_root_attempt`, `inspect_root_attempt` and `dispatch_root_attempt`. `DesktopRootPlanning` derives the predecessor from the old analysis journal or the current fresh-attempt chain and refuses known dispatch or a still-live original preparation. It retains at most two pending roots, with separate 30-second preparation and execution limits; same-connection retries keep their identity and deadline. It publishes metadata only after complete input persistence and rechecks membership, current journal state and the parent-derived Account/Profile/Host/connection binding before attestation or dispatch. Worker restart creates no executable recovery handle: another unused preparation gets a new attempt and retains its predecessor. Output commits beside the consumed grant, and disposal awaits pending work and journal writes. Cloud eligibility and grant authentication remain parent responsibilities.

The analysis-token `read_root_attempt` operation reads the latest durable attempt and verified saved output after owner restart without model preparation. It checks original-root membership before and after storage reads and discards results after cancellation or owner closure. Expired grants remain visible as consumed history; only a separate current cloud grant can authorize dispatch.

The analysis-token `root_execution_journal` operation delegates exact read/prepare/accept requests to the owning Session Controller. It retains Profile lifetime cancellation, rejects browser-only authorization and unknown fields, and publishes only the durable record or an explicit null read. It performs no model preparation or cloud dispatch.

The analysis-token `root_feedback` operation delegates private read/enqueue commands to Session Controller and retains cancellation and exact-field validation. Responses contain bounded persisted observations without result content. Browser cookies cannot authorize consumption, and the operation does not activate a model.

The same private `root_feedback` carrier also routes `consumer_prepare`, `consumer_start` and `consumer_read` to the durable consumer owner. Only a first current grant may wake the original Agent; the start request retains its cancellation lifetime through Agent settlement. Historical reads never restore a wake handle. Browser result controls send only a retained preview, task and delivery identity through authenticated Desktop Main.

The private feedback carrier also routes `continuation_read` to the original Session Controller. It returns either no committed observation or immutable first-reply coordinates; repeated reads preserve the original trace and never start another model request.

The private NDJSON route also accepts `session/list` with empty `args` and emits one complete Session-list snapshot, including projections. It uses the same 512 KiB item limit and cancellation as the existing streams.

Remote `session.select_model` and `session.select_agent` reuse the existing Session model selector and Agent preset registry. Both require the addressed Session control claim at the Host before invoking the Gateway; the response preserves the selected model or preset identity. A page cannot choose a Profile, a different Agent address, or a control epoch through the selection payload.

The lease-bound `workbench/read` stream admits only `workspaceFiles/read`, `readBytes`, `stat`, and `list`, with exact workspace scope and path arguments. It uses the Profile's in-process Connection Fetch handler and retains the original JSON or multipart RPC response. Ordered chunks are at most 16 KiB; the complete response is capped at 34 MiB. Cancellation closes the owned reader; unrecognized endpoints and authority selectors are rejected before dispatch.

The same file capability admits the exact `workspaceFiles/changes` stream. Gateway scope lookup and filesystem policy remain authoritative; page cancellation releases its watcher, and every Host poll still requires the original view lease.

The personal `settings.apply` command admits only the existing update, replace, and mutate form operations. It retains provider revisions and redacted namespace responses, bounds intents to 32 KiB, rejects authority selectors and unsafe JSON, and preserves typed conflict/rejection results without private exception text. It never changes the selected Profile or acquires conversation control.

The personal `credentials.apply` command admits only exact set/unset operations. Reference names retain the existing grammar and are capped at 128 characters; write-only values are capped at 16 KiB. The existing credential provider owns storage. Success has no returned value, known refusal details name only the reference, and neither provider values nor private diagnostics are echoed.

Controlled terminal calls retain the original Gateway arguments and reject cross-Session input; shell input and lifecycle changes require the current Host-issued Session proof.
