# Slark Device Shell Provider

English | [中文](2026-08-27-slark-device-shell-provider.zh.md)

## Decision

Implement the unchanged Harness `ShellExecutor` seam with a Slark Device provider. Foreground commands use one durable Device Task. Background commands use separate `start`, `poll`, and `kill` Device Tasks addressed by an opaque process id.

The cloud proxy persists only `startTaskId`, `opaqueProcessId`, and its last consumed output sequence. It can therefore be reconstructed after a Runtime Cell restart without retaining a process-memory object or issuing a second start.

## Output continuity

The Device Agent owns a bounded ordered output window. Poll responses carry `availableFromSeq` and `nextOutputSeq`. A caller behind the window resumes from the available boundary and reports `lossy`; it never claims the missing prefix was observed.

## Authority and privacy

Every operation is fenced by the selected workspace handle and current Grant. Control operations must match the start authority. Requests contain only virtual POSIX workdirs, and results never expose device paths or spill paths. There is no cloud-local fallback.
