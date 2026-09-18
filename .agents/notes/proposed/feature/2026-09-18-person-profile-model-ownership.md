# Agent Note: Person Profile ownership of legacy model credentials

Status: proposed

English | [中文](2026-09-18-person-profile-model-ownership.zh.md)

## Problem

The fixed OS-user `.dsh` home predates authenticated Person Profiles. Its credentials and model settings have no account owner. Importing them into the first active Profile silently assigns that account control of every provider. Per-Profile worker directories and empty launch environments isolate newly entered credentials but do not correct this legacy import.

## Proposal

The fixed legacy exporter transfers sessions and workspace while withholding all settings and credentials. Permission defaults and onboarding acknowledgements also belong to an account; copying them would change the first login's behavior without confirmation. It reads and validates the original documents, leaves them unchanged, and carries a digest of the withheld data so inventory confirmation detects a concurrent source change. This closes implicit assignment for new imports without changing ordinary Profile-to-Profile migration.

DSH Models settings will present a redacted, provider-specific claim action for an authenticated Person Profile. The claim will check source ownership and generation, commit the provider credential and corresponding route into that Profile, and record single-owner consumption before the route becomes usable. A failed or interrupted claim retains the original files and a retryable status. The same account may retry idempotently; a competing account receives a conflict. Existing Profile generations containing automatically imported legacy values require a separate upgrade migration before model reuse can be enabled in Desktop.

### Claim contract

The Models page reaches the claim action through the trusted Desktop bridge; the browser receives candidate names and status, never credential values or a path to the OS-user home. Host binds each candidate to a live Main-owned Account Profile view lease on a connection that verified an Account token through `profile.ensure`, the source inventory digest, and a short expiry. A vault-only restore, local-only or remote browser cannot claim. An unsupported plugin or ambiguous source mapping remains visible as unavailable instead of being guessed into a provider.

Read-only candidate inventory grants no claim authority. Host rechecks the Account lease on both sides of source inspection. On macOS, confirmation rereads the source digest and candidate, then mints a one-use authority bound to that Host connection and Account view for 60 seconds. Applying it rechecks the view before each transaction effect and consumes the authority before writing; a displayed inventory is never a standing grant. Only candidates with a present credential can be confirmed.

For each confirmed provider, Host stops the target Profile's worker and records both original target documents, then reserves durable single-owner ownership and marks the Profile pending before changing either live document. If reservation fails before the marker is published, the unchanged worker can restart. It copies only that provider's route and credential into owner-private files. A legacy reference shared by providers is rewritten to a unique Profile-local reference, so claiming one provider does not enable another. The source documents remain untouched. After validating both target documents and committing the receipt, Host clears the marker and restarts the worker. A crash or failed write leaves a pending receipt; the same account can retry or restore the target files from the recorded preimage, while another account receives a conflict. The UI reports only redacted progress and errors.

The global single-owner ledger is an atomic private snapshot, but worker startup must not depend on parsing that global file. Before target writes, Host also durably marks the affected Profile locally as pending; it clears that marker only after target verification and ledger commit. On startup, each Profile checks only its own marker before starting its worker. A damaged global ledger disables further claims while unrelated DSH Profiles continue to work. On macOS, the active mutable documents live beneath `migration-owner-state/<generation>/`; on Windows, they live beneath `owner-state/`. The immutable macOS `owner-state.json` seed is not the target because later personal edits diverge from it.

Worker startup checks the Profile-local pending marker both before and after starting the child; if the marker appears during startup, Host immediately disposes that child. Host fences the Profile in memory before a claim waits for worker shutdown and releases the fence only after a successful restart from verified documents. View activation checks the same fence. A failed shutdown or restart leaves only that Profile fenced for recovery.

After a Host restart, a pending marker prevents normal `profile.ensure` from starting the worker or issuing a view lease. Retry and restoration therefore use a separate proof from attested Desktop Main: a freshly verified Account access token, its current opaque binding, and the matching Main-vault unlock material. Host rechecks this proof before each recovery effect and accepts it only for an operation already recorded for that same Profile in the durable claim ledger. The proof grants neither a new claim nor a view lease; normal Account activation resumes only after recovery reaches a terminal state.

The recovery status reveals only the same Account's candidate id, operation id, source digest, and redacted state. A restored receipt remains discoverable only until its pending marker has been cleared. Retry refuses an unreserved operation or a changed operation id or source digest, so the worker-independent proof cannot authorize a new claim.

When the Account view cannot open, Desktop Main obtains the current Account token and matching local vault proof, then asks Host for a bounded inventory of that Account's unfinished receipts. The inventory includes pending reservations and a committed or restored operation whose Profile marker still blocks startup. Desktop's local navigation shell opens a native confirmation for one receipt at a time; the renderer receives no proof, credential, or receipt list. The Host rechecks ownership and the exact receipt before retrying or restoring. Recovery never runs automatically.

The macOS Host control protocol exposes recovery status and preimage restoration through that proof. It loads the global ledger lazily, so a damaged ledger makes recovery unavailable without preventing Host or unrelated Profiles from starting. Recovery does not read the old source and stays available even when source quiescence is not declared. Initial confirmation, write, and same-operation retry are advertised only after source quiescence is declared. Retry accepts only an already reserved claim for the same Account, candidate, operation id, and source digest. The Windows claim carrier remains separate work.

The Models UI now renders a Desktop-only claim card. The isolated renderer sends only candidate ids, source digests, and operation ids to Slark Main. Main binds requests to the visible personal Account view and displays a native confirmation before a claim, retry, or restore. It constructs fresh Account recovery proofs itself; no Account token, vault key, credential, or path enters the renderer. The claim card is absent in ordinary browsers. Installed runtime packaging remains separate work.

Before either target document changes, Host stores an operation-scoped, owner-private preimage of both documents and digests of both projected results in the affected Profile. Recovery may restore a document only when its current bytes match that preimage or the projected digest; a later personal edit is a conflict. This private snapshot contains credentials and must never enter the global ledger, Desktop IPC, or logs. A separate operation gets a separate snapshot, so a completed provider claim does not prevent another provider claim in the same Profile.

The target writer reads the current mutable settings and credential documents after worker quiescence. It rechecks the expected bytes before replacing each file, verifies both projected files after publication, and keeps the Profile pending when either write or verification fails. A retry derives the same projection from the recorded preimage and accepts only an original or projected version of each live document. The authenticated caller must serialize operations for that Profile and revalidate its lease or recovery proof before each effect.

The Host coordinator serializes operations per Profile. A retry after ledger commit verifies the target against the durable projected digests without rereading the mutable legacy source; a retry after verified restoration clears the remaining marker. Once the worker has restarted after a terminal outcome, Host deletes the private recovery snapshot by comparing its exact bytes. Cleanup failure remains visible as a redacted pending-cleanup result and does not stop an otherwise committed Profile.

Before committed-marker verification or pending-target restoration, Host confirms that the active persistence generation still matches the recorded claim generation. A changed generation leaves the affected Profile pending rather than reading or restoring an obsolete target.

The legacy default model is offered only after its provider is claimed and only when the target Profile has no personal default. The user explicitly confirms applying it. Existing Profile generations need provenance-aware inspection before any personal model request is enabled; if imported values cannot be distinguished from later personal edits, preserve the files and require an explicit resolution rather than deleting or silently trusting them. DSH workspace, sessions, and non-model actions remain available during this resolution.

## Alternatives considered

**Import all legacy credentials with the workspace.** This preserves the previous behavior but gives the first login implicit control of credentials that have no account owner.

**Discard the legacy files after transfer.** This prevents future claims and risks permanent credential loss on interrupted migration. The original files remain available as the claim source.

## Acceptance criteria

- A fresh legacy transfer leaves every setting and provider credential unavailable to both accounts until an explicit claim, while workspace and sessions survive.
- Claiming one provider exposes only that provider to the confirmed account; a second account cannot claim or read it. Repeated and interrupted claims have deterministic recovery without plaintext disclosure.
- A shared legacy credential reference is remapped per claimed provider; no other provider becomes usable through that claim. An interrupted claim never starts a worker with partially applied target documents.
- Existing automatically imported Profile generations are made safe before Desktop enables personal model reuse.
- macOS and Windows installed artifacts enforce the same account and source ownership rules.

## Risks

Withholding model data makes migrated Profiles temporarily unable to call a legacy model. Existing Profile generations may already contain imported credentials. The claim UI and upgrade migration must ship before this proposal can be treated as complete.
