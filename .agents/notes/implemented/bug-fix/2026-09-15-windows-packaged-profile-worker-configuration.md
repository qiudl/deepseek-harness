# Agent Note: Carry packaged Windows Profile configuration through a private pipe

Status: implemented

English | [中文](2026-09-15-windows-packaged-profile-worker-configuration.zh.md)

## Problem

Windows package activation may discard caller-supplied environment values between packaged processes. A Store-installed Desktop Host that configures `dsh web` only through `spawn(..., { env })` can therefore start a Profile worker without its home, Profile identity, credential handle, or plugin roots. Forwarding the ambient environment would also expose unrelated credentials, while argv and persistent files are unsuitable for the opaque credential handle.

## Decision

`DshWebProfileWorkerFactory` uses a fixed Node bootstrap on Windows. The parent serializes a versioned, 64 KiB-bounded record containing only its explicit Profile environment, sends it through inherited file descriptor 3, and closes the descriptor. The child validates the complete record and string fields, clears every ambient environment value, installs the explicit values, and imports the fixed DSH entrypoint. The ordinary stdin remains closed and the DSH CLI receives its existing `--profile web` arguments unchanged.

The parent rejects an oversized record before spawn. A missing configuration descriptor rejects startup, and a pipe error terminates the child. Non-Windows workers retain the direct explicit-environment launch.

## Alternatives considered

**Continue using `spawn` environment values.** Rejected because package activation has been observed to remove those values before the child reads them.

**Put the complete record in argv.** Rejected because process inspection would expose the Profile credential handle and plugin configuration.

**Write a temporary configuration file.** Rejected because another persistent pathname and cleanup lifecycle add disclosure and replacement risks that an inherited private pipe avoids.

## Consequences

Windows Profile startup no longer depends on custom environment inheritance and still exposes no ambient credentials. The dedicated descriptor consumes one additional inherited pipe only during bootstrap. Real-child tests exercise both direct and Windows pipe launches, require the explicit Profile values, reject ambient secret inheritance, and complete the authenticated loopback bootstrap exchange.
