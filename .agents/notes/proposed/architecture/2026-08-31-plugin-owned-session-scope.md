# Agent Note: Plugin-owned durable Session Scope

Status: proposed

English | [中文](2026-08-31-plugin-owned-session-scope.zh.md)

## Problem

A deployment plugin may need a durable identity that determines whether a Session may execute and how its Agent is composed. Keeping that identity only in process memory loses it on resume; adding one product's account, tenant, or employee vocabulary to core would violate the plugin architecture and prevent other providers from using the same mechanism.

## Proposal

`SessionHeader.scope` is an optional immutable `{ provider, ref, schemaVersion }`. `provider` names a plugin-owned namespace, `ref` is opaque to core, and `schemaVersion` lets that provider reject incompatible references. Session creation snapshots and validates the record, JSONL and SQLite preserve it, and fork inherits it exactly.

`AgentRegistry.registerScopeProvider()` is the extension seam. The agent-loop asks the exact registered provider to admit a scoped Session inside the unpublished creation transaction, before caller setup, registry entry, announcements, or driver start. The provider receives the unpublished `agentCtx`, so its scoped composition is owned and rolled back by that transaction. Missing providers and provider rejection fail closed. If the provider unloads while asynchronous admission is pending, the registry's exact-instance recheck rejects publication. Cancellation races the admission without publishing a candidate Agent or Session.

Core owns only durable transport, provider registration, lifecycle ordering, and failure closure. A provider plugin owns reference interpretation, authorization, remote calls, scoped tool/prompt composition, and compatibility policy. No ambient “current account” or mutable Host-wide identity is introduced.

SQLite advances its physical schema from 19 to 20 because its Session metadata is columnar and older binaries must not silently discard the new field. The event-row codec and session log format remain unchanged; the pre-release `SESSION_FORMAT_VERSION` remains 0.

## Acceptance criteria

- Scope metadata is lossless JSON, immutable after creation, preserved by JSONL and SQLite, and inherited by fork.
- Invalid provider/ref/version shapes fail at the Session header boundary.
- Exactly one provider can own a provider id; registration is effect-scoped.
- Fresh create and resume admit scope before setup and publication.
- Missing, rejecting, cancelled, or concurrently unloaded providers leave no live Agent or Session.
- Core source contains no provider-specific business vocabulary, endpoints, credentials, or mutable ambient identity.

## Risks

Admission may perform remote work, so providers must honor the supplied signal and make checks idempotent. Core races cancellation but cannot stop a provider that ignores its signal; it can only prevent late publication. A provider's `ref` must therefore be non-secret and safe to persist. Cross-scope fork is intentionally not a core operation: the inherited scope is fixed, and a product wanting a different scope must create a new Session through its provider-owned workflow.
