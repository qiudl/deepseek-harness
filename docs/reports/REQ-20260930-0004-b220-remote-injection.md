# REQ-20260930-0004 B220 — Collaboration history Remote dependency

ai-proj project 212 / Requirement 5845 / Task 23070; approved requirement and self-review recorded before product edits. Native baseline 2ec39000f2f369a9dbfaf7a75f945238ac7920e9.

Boston's real history view repeatedly threw `cannot get property "remote" without inject` when evaluating `resultsCtx.remote.session.collaborationSources`. Normal browser RPC reads of the same two owned Sessions returned HTTP 200 and empty source lists. This evidence identifies a missing Client dependency, rather than storage corruption.

The results injection now explicitly includes `remote` alongside its existing `remote.session` dependency. Existing result ownership, Session teardown and readonly transport remain intact.

Regression: the Loader fixture can now provide Remote through a real plugin owner instead of the root Context. In strict Cordis runtime, the added history-read test failed before the repair (source reads never reached the provider). It now succeeds and verifies that disposal stops further reads. This explains why the earlier root-provided test double hid the production dependency failure.

Validation: all 357 ui-slark-agent tests pass across 11 files; composer Loader suite 164 pass; Client aggregate typecheck and changed-file typed lint pass. RED/GREEN logs are /private/tmp/req20260930-b220-red.log and /private/tmp/req20260930-b220-green.log. No disk schema, Account data or credentials change. A second limited defect review found no additional issue in the dependency repair; actual signed-package history and the independent chat admission failure remain unaccepted.
