---
kind: upgrade-guide
description: "Native runtime-entry eligibility requires a schema3 installation owner resource instead of selected-file pins."
---

# Native entry requires installed owner metadata

English | [中文](guide.zh.md)

## Change

Native runtime-entry embedding configurations using selected-file pins no longer advertise `profile.runtime_entry`. Those historical configurations remain parsable for metadata reads, but cannot establish current installation eligibility. Ordinary consumption retains its existing early fallback. Existing entry, observation, attribution and delivery receipt bytes remain unchanged.

## Migration

1. Upgrade the embedding's verified runtime payload and canonical DS package together. Use its signed installation resource pipeline to produce `native-origins/owners-v3.json`; do not assemble a pin list or copy a manifest from another installation.
2. Pass the trusted schema3 resource reference through `runtimeEntryOriginsJson`. The embedding supplies the fixed manifest path and raw SHA after signed-resource verification; Profile patches and operation requests cannot supply them.
3. Verify `profile.runtime_entry` on the actual installed Profile and check that its original DS Loader registration is active. A missing or changed owner, package selection or native binary leaves Native unavailable. Reinstall the matching verified distribution rather than changing limits or deleting original entry records.

[Desktop Host](../../../../packages/host/desktop-host/README.md) owns the current Account/worker and installation checks.
