# Agent Note: Native operation settlement

Status: implemented

English | [中文](2026-11-07-native-operation-settlement.zh.md)

## Problem

Cancelling a socket or HTTP request can end its parent Promise while the Profile service still runs. Releasing concurrency at that point admits more than eight real operations. A child-process error also does not establish that the process has exited.

## Decision

The default Host's single Web worker factory owns eight native operation slots across Profiles and connections. Caller deadlines and cancellation end waiting independently. An authenticated receiver returns an operation-specific receipt only after its service settles. Without that receipt, the operation retains its slot until the original child actually exits. Worker shutdown can still terminate a live child after an error, and its completion waits for exit.

## Alternatives considered

Counting broker Promises or releasing on fetch rejection bounds waiting, not service execution. A per-worker counter permits excess work across Profiles and replacements. A persistent operation ledger adds storage and recovery ownership without improving the process-exit witness. Killing a user's worker merely to reclaim an uncertain slot disrupts unrelated Sessions.

## Verification

Eight cancelled callers can leave eight services running; the ninth is busy until one service actually settles. Mixed native routes share the limit. Missing receipts and HTTP disconnects retain slots, and only the original process exit reclaims them. A process error without exit cannot finish worker disposal. Successful proofs remain subject to current Account, worker and cancellation checks.

## Consequences

An unavailable receipt can retain capacity until a worker restart. Older receivers may execute before omitting the receipt; they cannot certify settlement. Cancellation does not undo an admitted atomic operation. Recovery keeps its original room, Source and member identity.
