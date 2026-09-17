# Agent Note: Desktop-mediated actions for embedded DSH

Status: proposed

English | [中文](2026-09-17-desktop-mediated-embedded-actions.zh.md)

## Problem

An embedded DSH renderer cannot use browser clipboard and download permissions because Slark Desktop deliberately denies them. Relaxing the Electron permission handler would grant unrelated page code ambient capability and would not provide a safe native Save As flow. The Web client also lacks a host-neutral image viewer with bounded zoom, focus management, and durable attachment saving.

## Proposal

Expose a versioned, DSH-only preload API for clipboard writes and durable attachment saving. Each action requires one trusted click captured by the preload and an active Desktop view authority. The main process derives the window, view, origin, profile generation, and lease; renderer input cannot select those values. Navigation, view replacement, account or profile change, lease change, hiding, and destruction invalidate pending authority.

The Web client negotiates explicit version-one features and uses stable result codes. An embedded client never falls back to the browser Clipboard API after the host rejects an action. Ordinary browser deployments keep their existing clipboard implementation. The image viewer owns fit and 25–400 percent manual zoom, anchored zooming, bounded panning, keyboard and pointer input, modal focus, and focus restoration.

### Attachment delivery

The Session Controller owns exact `GET|HEAD /api/session.attachment-export` requests for attachment references already present in the addressed Session log. The route requires the authenticated Connection request and `Sec-Slark-Desktop-Action: attachment-save-v1`. Browser JavaScript cannot set this reserved header, so page code cannot use the route as a generic file-reading API. HEAD returns bounded metadata; GET buffers normalized images within their admission limit and streams verbatim files through `readFileStream` with backpressure and cancellation.

Desktop obtains metadata before opening the system Save As dialog, then repeats authorization on GET. It checks response identity, byte count, and digest while streaming into a same-directory exclusive temporary file. Platform helpers reject links and reparse points, apply macOS quarantine or Windows Mark of the Web, flush data, and commit atomically. Renderer code never supplies a URL or destination path.

### Versioning and rollout

[`dsh-host-actions-v1.schema.json`](../../../../packages/api/session-controller/protocol/dsh-host-actions-v1.schema.json) is the language-neutral field and constant record copied into the Desktop repository with a pinned digest. DSH can ship first because missing host capability produces a localized unavailable result. Desktop advertises each feature independently and keeps the existing permission and download handlers closed.

## Alternatives considered

**Allow browser clipboard and downloads for the DSH origin.** Origin trust alone does not prove the active view, current profile authority, or a user gesture, and browser downloads accept URLs the host did not derive from a durable Session reference.

**Send attachment bytes through JSON RPC or preload IPC.** Images and files can be large. Aggregate serialization would duplicate bytes across processes and make cancellation and backpressure unreliable.

**Use the renderer-provided filename, URL, or path.** Those values let compromised page code redirect host I/O. The Session log, authenticated route metadata, system dialog, and native file helper own them instead.

## Acceptance criteria

- Clipboard writes require a current visible and focused DSH content view plus one consumed trusted click; clipboard reads remain unavailable.
- Image and file export succeeds only for an exact durable reference in the addressed Session log, while page-originated requests to the export route fail.
- Image viewing supports bounded zoom, pan, keyboard access, modal focus, and focus restoration without changing ordinary wheel scrolling.
- Navigation and authority changes cancel active work and suppress stale results; cleanup reaches closed streams, file handles, helpers, and listeners.
- macOS and Windows preserve the global permission denial, mark downloaded files with platform provenance, and pass the same protocol vectors.

## Risks

The main-process reserved-header request must be proved on the supported Electron version and must bypass page service workers. Native Save As focus transitions need an explicit modal lease so the dialog does not invalidate itself. A process crash may leave an owner-only random temporary file in a user-selected directory; cleanup scans only that directory after a later user selection rather than persisting sensitive paths or scanning the filesystem.
