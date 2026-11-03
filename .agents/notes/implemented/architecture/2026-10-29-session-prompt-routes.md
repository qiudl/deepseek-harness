# Agent Note: Session prompt sender ownership

Status: implemented

English | [中文](2026-10-29-session-prompt-routes.zh.md)

## Problem

A remote Bot chat reuses the ordinary Conversation, but sending to its Session through the generic endpoint bypasses Bot admission and stable delivery receipts. Losing a client plugin must not silently change that authority.

## Decision

The Client sessions service registers one explicit prompt route per Session identity before the domain opens it. It preserves the original composer request and cancellation signal. The domain owns admission and the accepted result; the Session still owns history and the input retains its existing draft behavior. Route withdrawal cancels pending calls and leaves a page-lifetime tombstone. Only identities never registered use the ordinary sender. A replacement domain owner may register the identity again; a late result from an old owner remains rejected.

The remote carrier flag is presentation information. Remote workspace startup defers restoration to its home owner, avoiding an unrelated blank Session before Bot identity resolves. Authorization remains on the Host and carrier.

## Alternatives considered

**A second Bot composer.** It would duplicate draft, input, history and accessibility behavior. Routing the existing Session prompt preserves one UI and the original request ID.

**Return to the generic sender on withdrawal.** That would turn plugin unloading or a reconnect into an admission bypass. A tombstone makes loss of the owner visible until a valid replacement registers.

## Consequences

A domain must register the route before navigation and dispose it with its scope. The page retains withdrawn identities until the sessions service closes. This mechanism does not discover domain ownership, grant remote control, persist unconfirmed sends across page reloads, or change subagent admission. The owning domain must reconcile unknown outcomes against the original identity and receipt.

## Testing

The service tests cover the original request identity, ordinary unregistered sends, duplicate owners, withdrawal, replacement and late cancellation. Workspace tests prove remote startup performs no automatic restoration while explicit navigation remains available. Bot composition and phone drawer browser checks belong to REQ-20261018-0001.
