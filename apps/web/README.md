# @deepseek-ai/dsh-web-frontend

English | [中文](README.zh.md)

This application builds the browser entry for the DSH Web Client. The supported Node launcher is [`dsh web`](../cli/README.md); building this static application does not launch a Host or create a Profile.

## Remote Slark carrier

The separate `remote-bootstrap` build entry connects an isolated page to its Slark parent. `VITE_DSH_REMOTE_PARENT_ORIGIN` must be the parent's exact HTTPS origin. The carrier accepts one MessagePort only from that parent window and origin with the original nonce. Authenticated Host boot bytes and Client bundles arrive over that port.

Before Client plugins apply, the carrier reads `/__collaboration__` over the port. A parent advertising `dsh-remote-collaboration/v1` with only `workspace` installs the scope bridge. Missing, invalid, unknown or timed-out capability metadata leaves ordinary remote chat available without that bridge. An unsupported parent can answer discovery with HTTP404 and still serve authenticated boot. The five-second discovery deadline also covers its response body.

The bridge forwards only captured workspace and Session coordinates and one `get`, `apply`, `projects` or `agents` operation to the parent's `collaboration/workspace` RPC. It checks the RPC identity, nested result, workspace, scope version and directory fields. It carries no account credentials or selectable computer identity, and uses no browser network fetch. Requests are at most32 KiB; complete responses are at most256 KiB. The thirty-second operation deadline covers response-body consumption. A failed save that was sent requires a fresh read, because cancellation does not establish whether it committed. Page teardown cancels outstanding work and removes the owned bridge; late discovery cannot install it.

Scope-only parents expose no execution methods. A parent advertising exactly `workspace`, `submit`, `pending` and `deliveries` also installs original Source submission and status/result reads. These calls use the same authenticated port, captured original coordinates, a 38-second deadline and at most800 KiB of response data. Submission requires explicit Agent mentions; changed coordinates, injected identities and invalid RPC envelopes are refused. Cancellation after sending preserves uncertainty without automatic resubmission. The parent verifies complete result projections and persisted delivery; Client plugins validate and display the original-message groups. Ordinary task assignment uses explicit Agent mentions in chat. The parent must provide the owning runtime's original Source feed before advertising execution; scope support alone does not establish Agent execution acceptance.

## Verification

The [remote carrier tests](tests/remote-boot.spec.ts) exercise the authenticated handshake and installation order. The [scope consumer tests](tests/remote-collaboration.spec.ts) use the real WorkerTunnel and MessagePorts, including refusal, cancellation and deadlines. These isolated tests do not establish live Account, provider or independent Agent execution acceptance.
