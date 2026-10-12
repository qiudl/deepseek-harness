# Agent Note: Lease-owned compressed UI assets

Status: proposed

English | [中文](2026-10-12-lease-owned-compressed-ui-assets.zh.md)

## Problem

REQ-20260930-0015 requires ordinary Web access to the original remote DSH workbench within five seconds. Raw 24 KiB Host reads multiply private worker HTTP and control-channel calls even when the outer daemon aggregates them.

## Proposal

Compress the complete authorized plugin asset inside the Profile worker and return compressed 24 KiB chunks through `asset/read-gzip-chunk`. Negotiate the additive endpoint through signed `profile.remote_ui_asset_gzip` inspection. Retain the existing endpoint for peers without the capability. One current worker cache entry owns raw bytes and a shared compression promise; it retains no permission decision.

Keep exact current injection membership, same-origin script restriction, Account/view lease checks, cancellation, original SHA-256 validation, and the complete 64 KiB frame limit. Limit raw bytes to 8 MiB and gzip bytes to 8 MiB plus 64 KiB. The daemon and Web consumer must preserve these limits and decompress only after assembling the complete compressed asset.

## Alternatives considered

Raising control-frame limits increases retained data and does not remove repeated raw worker reads. Publishing private modules through a public asset server changes authorization and delivery assumptions. Caching injection authority can outlive revocation. Whole-asset compression reduces reads while preserving current authorization ownership.

## Acceptance criteria

Old peers retain raw reads. Signed capability checks gate client and server execution. Exact original bytes survive multi-chunk decompression, including incompressible and empty assets. Revoked injections, cancelled work, and stale view leases reject cached reads. Matching Slark consumers and canonical release artifacts must pass ordinary Web-to-Boston functional checks and cold/warm full-workbench P95 measurements before the requirement closes.

## Risks

Compression adds bounded worker memory and CPU. A late completion must not escape cancelled work; a failed compression must not poison the cache. Smaller resource-transfer time alone does not establish the five-second workbench requirement.
