# Agent Note: Account issuer Profile continuity

Status: implemented

English | [中文](2026-09-10-account-issuer-profile-continuity.zh.md)

## Problem

Separating staging and production DSH Account issuers changes the device-keyed person index for an existing staging user. The environment binding still identifies the same authorized workspace, but a registry that treats the replacement issuer as an unrelated person rejects the request and leaves sessions, plugins, settings, and runtime upgrades behind an unreachable Profile.

Desktop also needs to distinguish a legacy session from no Account history. Treating the configured issuer as the stored credential's issuer hides the old Profile behind a newly created local Profile, while using that credential in the configured environment crosses the Account trust domains.

## Decision

`ProfileRegistry.registerAccount` atomically replaces an Account Profile's person index when a request proves all continuity facts: the same authority environment and binding handle already own the Profile, the binding version strictly increases, the Keychain handle is unchanged, the unlock material matches in constant time, no Profile already owns the replacement person index, and the Host has verified the replacement identity's Account token. The Profile id, directory, sessions, plugins, settings, and runtime state remain unchanged. The former person index stops resolving after commit.

Slark derives a persisted session's issuer from its encrypted Host-audience token for recovery detection. A session whose issuer differs from the selected environment remains a recovery marker but cannot authorize requests or refresh in that environment. After a current staging Account verification, Slark adopts the one matching legacy production handle for the same subject; conflicting handles fail closed. The higher server binding version then authorizes the Host's atomic issuer replacement.

## Alternatives considered

**Create or open a local Profile after Account recovery fails.** This makes intact data appear deleted and lets repeated retries create more unrelated Profiles.

**Use the legacy Account token in the selected environment.** Production and staging are separate trust domains, so a credential from one issuer cannot authorize the other.

**Copy Profile directories into the replacement identity.** File copying cannot preserve Host registry generations, selectors, leases, or transactional migration semantics and risks partial or duplicated state.

**Accept the same binding version for issuer replacement.** A legacy credential could rotate the Profile back. A strictly higher server version makes the authority's identity transition monotonic.

## Consequences

An issuer-separated environment may require one current Account verification and a server-issued higher binding version. Recovery never overwrites Profile content and never reuses a mismatched credential. A server that does not advance the binding version receives `stale` and leaves the original Profile untouched.

The focused registry and authenticated Unix transport tests preserve the Profile id across replacement and reject equal versions, a different Keychain handle, and incorrect unlock material. Desktop tests pin legacy issuer detection, cross-environment credential rejection, and legacy-handle adoption before local fallback.
