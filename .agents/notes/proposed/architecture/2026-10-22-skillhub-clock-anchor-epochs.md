# Agent Note: Skill Hub clock anchor epochs

Status: proposed

English | [中文](2026-10-22-skillhub-clock-anchor-epochs.zh.md)

## Problem

The Host keeps exact revisions for at most 4,096 offline clock anchors. Under the original protocol, a caller supplies any UUID to the witness. Once an old entry is discarded, the Host cannot distinguish that UUID from an unseen one and may accept a fresh revision-zero compare-and-set. Keeping every entry forever instead eventually rejects new online enrollments in a long-running Host.

## Proposal

The Host issues each new anchor UUID with a one-time ticket under the current Profile grant. The first compare-and-set presents that ticket and the current random epoch. A new epoch invalidates old witnesses and pending tickets before the Host clears its bounded ledger. For a Work issue at capacity, the Host retains only the selected current asset witness in the new epoch; the Daemon refreshes that asset authority online before enrolling Work. The Server confirms the Host-issued UUID through authenticated online time, while the Daemon binds the epoch into offline authority and checks it before each action. The V1 witness remains a separate capacity-bound compatibility path.

## Alternatives considered

**Eviction of V1 entries.** Without an authenticated issuance proof, an old UUID can be initialized again after eviction. LRU and time-based eviction have the same gap.

**Restarting the Host at capacity.** A new process boot nonce invalidates existing offline authority, but the V1 witness still accepts arbitrary UUIDs after its empty ledger starts. Restart also interrupts unrelated Host work.

**Persistent exact ledger.** Durable tombstones could reject old UUIDs, but require storage integrity, backup and growth policy across Host upgrades. The bounded epoch protocol avoids that durable state if all callers migrate together.

## Acceptance criteria

The 4,097th Host-issued anchor can initialize after rotation. Old anchors cannot initialize under the new epoch, including with a new ticket; old tickets cannot initialize under any epoch. At a Work-triggered rotation, only the selected asset witness remains readable under the new epoch; other old witnesses disappear. In-flight asset and Work operations deny further irreversible actions after rotation. An online refresh succeeds after the rotation, while the V1 path continues to refuse new anchors at its own capacity.

## Risks

Epoch rotation revokes existing offline authority. A Work-triggered rotation preserves one asset witness but requires fresh online asset authority before the original Work can enroll; refresh failure closes that registration. A caller that cannot complete Server confirmation before ticket expiry must request a new ticket. Partial deployment must keep V2 offline execution disabled; merely advertising the Host capability does not establish the Server and Daemon checks.
