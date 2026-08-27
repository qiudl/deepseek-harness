# Agent Note: Slark Device filesystem provider

Status: implemented

English | [中文](2026-08-27-slark-device-filesystem-provider.zh.md)

## Problem

The Slark cloud composition needs Harness file tools to operate on a user-selected directory on their computer. A cloud process cannot use that local path, and exposing the path or silently mounting `fs-local` would break both the trust boundary and the user's expectation that work runs on the selected device.

## Decision

Split the integration at the existing capability seam. `dsh-slark-device-client` owns the internal Gateway transport, operation-scoped identity, durable task idempotency, long polling, cancellation, output cursors, and SHA-256 verification. `dsh-fs-slark-remote` implements the unchanged `FileSystem` service over that client.

The provider exposes one virtual POSIX root, `/workspace/<workspaceHandle>`. Requests carry only normalized relative paths, opaque target keys, the Workspace Grant fence, and operation payloads. Reads are raw base64 pages with an expected-version fence after page one; the provider owns cross-page UTF-8 decoding and binary sampling. Writes and edits preserve the service's optional guards, including unconditional mutations, and receive a side-effect key distinct from the transport idempotency key.

There is no local fallback. Missing identity, an unavailable device, a changed workspace, an output gap, or malformed/digest-invalid data produces a typed failure. This keeps the cloud cell unable to observe or mutate an unrelated server filesystem when the user's device authority is absent.

## Consequences

- Existing model-facing file tools and observation policy need no schema changes.
- Device-local absolute paths never enter the cloud task or model-visible result; process coordinates remain virtual and match the later remote shell provider.
- Ambiguous creation retries one idempotency key. Once a task ID exists, retries query only that task, so mutations are not duplicated by transport uncertainty.
- Large reads can stream without whole-file buffering in the cloud provider, while version changes between pages fail rather than combining two file revisions.
- The cloud preset must load the identity adapter and Device client before the remote filesystem and must exclude every local filesystem provider.

## Alternatives considered

- **Mount the user's directory into the cloud cell** — rejected because ordinary cloud deployment has no route to the user's filesystem and would expose host-specific paths.
- **Add Slark logic directly to the model-facing tools** — rejected because it would duplicate filesystem semantics and bypass the provider/policy seam.
- **Fall back to cloud-local files while the device is offline** — rejected because the same virtual path would silently name a different filesystem.
