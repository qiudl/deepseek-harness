---
kind: upgrade-guide
description: "Existing Slark Bot updates require a declared package/data migration instead of package-only replacement."
---

# Existing Slark Bot upgrades

English | [中文](guide.zh.md)

## Change

POSIX Desktop Hosts refuse package-only updates of existing `ds-bot` Profiles, including npm and GitHub sources. An embedding application must declare the exact target and historical archive hashes in `profile-upgrades.v1.json` beside `catalog.v1.json`. Undeclared versions, custom Bot Home paths and conversions that remove or change existing data remain unavailable. Fresh installation into an empty Bot Home remains supported.

An upgrade retains original Bot and committed JSONL generations. Once the new worker may have written, recovery continues the original operation on the new data; it never restores an older snapshot over new messages. A package-only downgrade of managed data prevents worker startup. Explicit plugin removal retains the data.

## Migration

1. Install a Desktop build that supplies both the verified target archive and its reviewed `ds-bot-v1` policy. In Slark, open the intended Local or Slark Profile, then choose its DS Bot **upgrade to bundled version** action in the extension center; confirm the observed installed and target versions. Disabled, removed and custom plugins require a separate decision and are not automatically replaced.
2. If the outcome is unknown, retain its original operation ID and use Slark's **Recover DS Bot upgrade** menu to reopen the same Profile through its existing unlock authorization. Do not repeat the update, edit its journal or replace package/data directories. Unsupported data conversions require a reviewed adapter, not deletion of the rejected fields.
3. Confirm the original receipt succeeded, the installed version matches the bundled target, and the new worker acknowledged that exact version. Check history, attachments, preferences and pending work in that same Profile. A downloaded installer or an old ledger entry alone does not establish completion.
