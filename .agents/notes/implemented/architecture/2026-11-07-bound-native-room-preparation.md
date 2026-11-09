# Agent Note: Bound native room preparation

Status: implemented

English | [中文](2026-11-07-bound-native-room-preparation.zh.md)

## Problem

A room ID and Account Profile do not establish that the selected Bot still participates. Reading participation and then invoking an unscoped preparation leaves a creation race. A native-room assertion also lacks the binding, nonce and exact Profile needed by a Cloud coordinator. An asynchronous authorization helper can return after its final check while revocation or worker replacement runs before parent signing.

## Decision

The independent preparation capability executes one phase per request. Its target and proof bind the original participant, complete Source, Profile, binding selectors, audience and short nonce. The worker requires the plugin's guarded preparation entry before creation; known Sources and both attestation phases read only the original strict journal. The worker returns unsigned observations, and the parent signs the original artifact and the separate preparation domain.

The parent retains the original worker receiver and its synchronous current-worker guard through final publication. It rechecks that guard together with Account, Profile, nonce and cancellation before every signature and before sending the response. A replacement with the same Profile cannot validate an older observation. The single default factory shares the existing actual-settlement budget with other native operations.

## Alternatives considered

Calling the old preparation method and comparing afterward permits an unwanted Source to be created. Reusing its assertion alone omits the selected participant and one-use context. Giving the child installation signing authority enlarges its authority. Rechecking only inside an asynchronous helper leaves its return continuation unprotected. Re-selecting a worker by Profile accepts a replacement that did not produce the observation.

## Consequences

Older plugin or worker support requires upgrade without fallback. Unknown writes retain the original Source intent; cancellation does not undo an admitted atomic operation. The complete escaped response is bounded before signing and is never truncated. These observations grant no Cloud group, model or device rights; the Cloud coordinator retains current business authorization and commit ownership.
