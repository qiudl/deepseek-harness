# Agent Note: Windows Store package identity for peer attestation

Status: implemented

English | [中文](2026-09-14-windows-store-package-peer-identity.zh.md)

## Problem

Microsoft Store signs the outer MSIX package after certification but does not add Authenticode signatures to the Desktop and Host executables inside it. Requiring an inner executable publisher certificate therefore rejects a valid Store installation, while accepting a package family name without proving the executable location would let a package-associated process attest bytes outside the protected install root.

## Decision

Windows pipe peer attestation uses a closed union of two release-pinned identity modes. Authenticode mode requires one or more allowed publisher thumbprints. Store mode requires one or more allowed package family names, obtains the peer's package full name from its stable process handle, derives the family name and protected install path through Win32 package APIs, and requires the stable executable path to be a descendant of that root. Both modes require the same-user SID and an allowed SHA-256 executable digest.

Worker boot data carries both identity lists but accepts exactly one non-empty list. Ready evidence carries exactly the selected identity fact, and the parent checks that fact again against its trust snapshot before it accepts the Worker.

## Alternatives considered

**Require Authenticode inside MSIX** — rejected because Microsoft Store does not provide that signature and it would preserve a paid certificate dependency for the Store channel.

**Trust only the package family name** — rejected because package association alone does not state that the attested executable bytes came from the protected package installation directory.

**Copy the Host executable to writable user storage** — rejected because the copy loses the package-path integrity evidence that makes the Store identity mode useful.

## Consequences

The NSIS channel retains its publisher-and-digest policy. The Store channel can use Microsoft-managed package signing without weakening peer identity to a path string or digest alone. Store-packaged embedders must run both peers from protected package files, pin the Partner Center package family name, and update executable digests for each release. Native Windows execution remains the verification owner for the package API ABI and installed-path behavior.
