# Agent Note: Slark Device Shell provider

Status: implemented

English | [中文](2026-08-27-slark-device-shell-provider.zh.md)

## Problem

The Slark cloud composition must execute foreground and background Shell requests on the selected Desktop device without exposing its paths or silently falling back to the Runtime Cell. Background commands must survive a Cell restart without running the command twice, while bounded Device output retention means a delayed poll may no longer have the complete prefix.

## Decision

Implement the unchanged Harness `ShellExecutor` seam with a Slark Device provider. Foreground commands use one durable Device Task. Background commands use separate `start`, `poll`, and `kill` Device Tasks addressed by an opaque process id.

The cloud proxy persists only `startTaskId`, `opaqueProcessId`, and its last consumed output sequence. It can therefore be reconstructed after a Runtime Cell restart without retaining a process-memory object or issuing a second start.

## Output continuity

The Device Agent owns a bounded ordered output window. Poll responses carry `availableFromSeq` and `nextOutputSeq`. A caller behind the window resumes from the available boundary and reports `lossy`; it never claims the missing prefix was observed.

## Authority and privacy

Every operation is fenced by the selected workspace handle and current Grant. Control operations must match the start authority. Requests contain only virtual POSIX workdirs, and results never expose device paths or spill paths. There is no cloud-local fallback.

## Alternatives considered

**Keep a Cell-local Shell fallback.** Rejected because success in the Runtime Cell would operate on a different filesystem from the selected Device and violate the Workspace Grant.

**Keep background process state only in Cell memory and restart after loss.** Rejected because a Cell restart would either orphan control of a running process or execute the command a second time. Durable task and process identifiers restore control without replaying `start`.

## Consequences

Foreground and background Shell operations share the Device authority and virtual-path rules. Background control survives Cell restarts, but a caller that falls behind the bounded output window receives an explicit `lossy` result instead of the missing output prefix.
