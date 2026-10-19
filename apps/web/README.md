# @deepseek-ai/dsh-web-frontend

English | [中文](README.zh.md)

This application builds the browser entry for the DSH Web Client. The supported Node launcher is [`dsh web`](../cli/README.md); building this static application does not launch a Host or create a Profile.

## Remote Slark carrier

The separate `remote-bootstrap` build entry connects an isolated page to its Slark parent. `VITE_DSH_REMOTE_PARENT_ORIGIN` must be the parent's exact HTTPS origin. The carrier accepts one MessagePort only from that parent window and origin with the original nonce. Authenticated Host boot bytes and Client bundles arrive over that port.

Before Client plugins apply, the carrier reads `/__collaboration__` over the port. A parent advertising `dsh-remote-collaboration/v1` with only `workspace` installs the scope bridge. Missing, invalid, unknown or timed-out capability metadata leaves ordinary remote chat available without that bridge. An unsupported parent can answer discovery with HTTP404 and still serve authenticated boot. The five-second discovery deadline also covers its response body.

The bridge forwards only captured workspace and Session coordinates and one `get`, `apply`, `projects` or `agents` operation to the parent's `collaboration/workspace` RPC. It checks the RPC identity, nested result, workspace, scope version and directory fields. It carries no account credentials or selectable computer identity, and uses no browser network fetch. Requests are at most32 KiB; complete responses are at most256 KiB. The thirty-second operation deadline covers response-body consumption. A failed save that was sent requires a fresh read, because cancellation does not establish whether it committed. Page teardown cancels outstanding work and removes the owned bridge; late discovery cannot install it.

Scope-only parents expose no execution methods. A parent advertising exactly `workspace`, `submit`, `pending` and `deliveries` also installs original Source submission and status/result reads. These calls use the same authenticated port, captured original coordinates, a 38-second deadline and at most800 KiB of response data. Submission requires explicit Agent mentions; changed coordinates, injected identities and invalid RPC envelopes are refused. Cancellation after sending preserves uncertainty without automatic resubmission. The parent verifies complete result projections and persisted delivery; Client plugins validate and display the original-message groups. Ordinary task assignment uses explicit Agent mentions in chat. The parent must provide the owning runtime's original Source feed before advertising execution; scope support alone does not establish Agent execution acceptance.

The parent can also advertise `conversations` and `archive` separately. `archive` accepts only a Workspace ID, Session ID and `archive` or `restore` action. The parent forwards it through the encrypted Daemon connection; the Daemon owns the durable token, current Account lease, Native phase proof and cloud challenge. The child never receives the token or proof. An uncertain result remains retryable with the original Native intent.

## Verification

The [remote carrier tests](tests/remote-boot.spec.ts) exercise the authenticated handshake and installation order. The [scope consumer tests](tests/remote-collaboration.spec.ts) use the real WorkerTunnel and MessagePorts, including refusal, cancellation and deadlines. These isolated tests do not establish live Account, provider or independent Agent execution acceptance.

The plugin installation browser test records card and highlight changes with browser timestamps when the highlighted card is unavailable. It retains the visibility timeout and rethrows the original failure.

## Native mobile input capabilities

REQ-20261018-0001 adds optional `/__native_workbench__` discovery alongside collaboration discovery. Only an exact `dsh-native-workbench/v1` response advertises Duet or draft support. The carrier installs a separate `__DSH_NATIVE_WORKBENCH__` capability object before Client plugins apply; unsupported parents keep ordinary browser behavior. Native calls send only the current Session ID, never account, computer, audio or credentials. Draft reads/writes retain the existing revision/text contract. Strict request/response shapes, bounded bodies and deadlines apply; page disposal aborts pending operations and removes its capability object. It never ends an accepted native call.

## App-bundled Web entry

After the Host and Client library build, run `pnpm --filter @deepseek-ai/dsh-web-frontend exec vite build --config vite.native.config.ts --mode native`. `dist-native/native.html` inlines the same Web shell, CSS, fonts and lazy language modules. Only that HTML is copied into the signed App; generated output is ignored by Git. The App embeds it in `srcdoc` with `sandbox="allow-scripts"`, without same-origin access. This dedicated build accepts one nonce-bound port from its own opaque parent window, validates the parent's HTTPS asset namespace, and uses that namespace only for tunnel requests. The normal HTTPS remote build retains its exact configured origin check.

The document permits the existing Cordis expression compiler (`unsafe-eval`), matching the isolated production carrier, while keeping network access disabled. Its single inline entry is SHA-256 bound; verified plugin scripts use Blob URLs. Browser preferences use bounded frame-local memory; private persistent history and drafts belong to the native encrypted bridge. `node apps/web/tests/native-built.mjs` exercises the actual built document in an isolated browser frame, including CSP execution, WebCrypto, memory storage and the first Host request. This startup smoke does not establish offline history or live Host acceptance.
