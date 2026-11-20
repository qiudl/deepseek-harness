---
kind: upgrade-guide
description: "Offline Account recovery Host requests require an environment UUID and a new capability."
---

# Offline Account recovery environment guard

English | [中文](guide.zh.md)

## Change

The Host control requests `profile.recovery_inspect`, `profile.recover_offline_account`, and `profile.open_offline_account` now require `expected_environment_id`. The Host checks this UUID against the Account Profile's persisted binding before recovery or opening. A Profile with missing, conflicting, or different environment bindings is refused. Clients require the `profile.offline_environment_guard` inspection capability; an older Host cannot perform offline Account recovery.

## Migration

1. Update every caller of `UnixHostClient.inspectOfflineAccountProfiles`, `recoverOfflineAccountProfile`, and `openOfflineAccountProfile` to pass `expectedEnvironmentId` from the caller's trusted current environment. Do not derive it from a cached selector or key-handle location.
2. Upgrade the Host and client together. Confirm `host.inspect` advertises `profile.offline_environment_guard`.
3. Test a Profile bound to the current environment, one bound to a different environment, and one without a binding. Only the first may recover and open.
