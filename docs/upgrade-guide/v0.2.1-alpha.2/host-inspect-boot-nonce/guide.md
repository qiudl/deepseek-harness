---
kind: upgrade-guide
description: "Host control clients must accept the signed boot_nonce field in host.inspect results."
---

# Host inspect includes a process boot nonce

English | [中文](guide.zh.md)

## Change

The `host.inspect` result now contains `boot_nonce`, a canonical base64url nonce generated for each Host authority process and covered by the installation signature. Clients that decode the result with the previous exact field list reject upgraded Hosts.

## Migration

1. Update consumers of `HostInspectResult` to decode `boot_nonce` and include it in `encodeHostInspectSignaturePayload` verification. Keep the existing installation and process identity checks.
2. Bind offline authority that depends on in-memory Host witnesses to `boot_nonce`. A new Host process invalidates prior offline authority even when Desktop restarts it with the same configured `host_instance_id` and `process_nonce`.
3. Confirm that two connections to one Host authority return the same `boot_nonce`, while a new authority returns a different value and prior offline authority is rejected.
