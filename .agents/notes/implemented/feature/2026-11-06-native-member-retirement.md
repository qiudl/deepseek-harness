# Agent Note: Native member retirement acknowledgements

Status: implemented

English | [中文](2026-11-06-native-member-retirement.zh.md)

## Problem

A native leave cannot close a member that has not arrived. A delayed original join can follow an unavailable leave and activate that cycle. A signed ordinary leave reply does not independently state that a never-joined original cycle has a durable retirement fence. Cloud recovery needs that stronger fact before opening another cycle.

## Decision

The independent private capability `profile.native_room_retirement` closes the original cycle. Its target contains the existing challenge nonce, expiry, binding id and captured generation, plus `join_command_request_id`, `join_command`, `leave_command_request_id` and `leave_command`. The commands use the existing strict join and leave schemas, have distinct request ids, and must select the same room, member and cycle. The join retains its original group, project, Agent and name. The Cloud binding selector is echoed context, not Host authentication of that relation.

The current Account selects one actual Profile. Check its grant before and after the current worker operation, require the same worker generation, and withhold a reply after cancellation or peer replacement. The private Profile request receives only the complete original join command and calls the plugin's `retireAgent`; no Cloud binding, challenge or command request ids reach the plugin. The operation creates no Source, Session or model invocation. Missing worker or Profile is unavailable; a missing method is upgrade_required, with no ordinary-leave fallback.

Sign only a strict durable left reply with a nonnegative safe integer boundary. The proof has schema_version1, purpose native_room_retirement, the complete original target and existing Account/Profile/installation/process authority fields. Its Ed25519 payload uses `dsh-native-room-retirement/v1\0` followed by the fixed JSON tuple `[1,purpose,[nonce,expiry,bindingId,generation,joinRequestId,joinCommandTuple,leaveRequestId,leaveCommandTuple],["left",leftRoomSeq],authorityTuple]`; command and authority tuples retain the established projection field order. Never sign conflict, invalid, unavailable or unknown acceptance. The Unix client checks target equality, current peer, Account, expiry and signature before returning the proof.

Reuse the existing bounded worker-token request lifecycle, current Account authorization and control-frame limits. Register a separate Profile-private route and optional worker handle, outside view leases. Its result parser preserves explicit upgrade_required and rejects joined or unrelated native results. The outer control capability is advertised only when the dedicated callback exists. Wire codecs, client result matching, worker cancellation, actual private-route registration and compiled Slark broker consumers all need matching tests.

Cloud must separately verify current owner/environment and the original persisted join/leave intents. A captured generation can be ended for cleanup; it cannot authorize a new model use. Account or installation changes without original cleanup authority remain pending. The current storage accepts only ordinary projection proofs, so a later additive migration must accept this independent purpose; this capability cannot manufacture a compatible ordinary leave proof. Legacy records lacking a proven original full join need a separate recovery decision, never guessed names or identities.

The existing [Account issuer continuity decision](../../implemented/bug-fix/2026-09-10-account-issuer-profile-continuity.md) remains applicable and is not superseded. This operation adds neither identity migration nor an alternate Profile selector.

## Alternatives considered

**Reuse the ordinary leave proof.** Its exact target lacks the original join identity and its semantics do not promise a fence for a missing member. Widening it would let old consumers mistake a new guarantee for the old one.

**Retry the join before leaving.** This can briefly activate a revoked member, creates work during cleanup and needs current join authority that may already have ended.

**Treat missing or timeout as retired.** Neither prevents a delayed accepted join. Only a durable cycle-closing result can release the next-cycle block.

## Verification

Strict parsers reject cross-room/member/cycle pairs, reused request ids, extra fields, accessors, malformed strings and unsafe sequence values. The shared deterministic fixture pins golden signature bytes for Host and Slark. Real control, worker-process and private HTTP compositions cover current Account/worker/peer checks before and after await, missing capability, cancellation, tampered proofs and sequence0. The owning test suites and selected-source coverage verify the operation independently of Cloud business authorization. Build artifacts/check verify its compiled exports.

## Consequences

A plugin can finish a durable close after its response is lost. Recovery must retain both original request ids and commands and retry that identity; it must not infer absence or invoke a model. The independent capability requires coordinated Host, plugin and Cloud upgrades. It does not solve unknown historical identities or grant cleanup across an Account or installation-key change.
