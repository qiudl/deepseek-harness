# Agent Note: Optional authenticated encryption for managed credentials

Status: implemented

English | [中文](2026-08-29-optional-encrypted-credential-documents.zh.md)

## Problem

[`credentials-local`](../../../../packages/credentials/credentials-local/README.md) deliberately keeps provider credentials out of the process environment, but its managed YAML document is plaintext. Owner-only filesystem permissions isolate users on a workstation; they do not protect persisted cell state, snapshots, or backups in a cloud deployment. Slark's remote-only Runtime Cell needs the existing Models-page write path while keeping the durable per-user document encrypted and without copying a Slark service secret into the Harness.

The encrypted mode must remain optional. Changing the default document format would break ordinary local installs and would make an older rollback build attempt to parse ciphertext as YAML.

## Decision

`credentials-local` accepts an optional absolute `encryptionKeyFile`. When present, the configured document path stores a canonical `dsh-credentials-encrypted-v1:` envelope instead of YAML. Each write uses AES-256-GCM with a fresh 96-bit nonce, a 128-bit authentication tag, and fixed format-version associated data. Load, reload, and read-modify-write authenticate and decrypt before parsing; malformed input, tampering, or a wrong key fails closed without putting a secret value in diagnostics.

The key file contains one canonical 32-byte base64url key. It must be a regular, owner-only file on POSIX and is read once at plugin activation. A file directly inside systemd's declared `$CREDENTIALS_DIRECTORY` is also accepted only with systemd's exact read-only `0440` copy mode; the systemd credential contract limits that private copy to the unit user and root. The key is never copied into plugin output or the process environment and its in-memory buffer is zeroed on disposal. Deployments own key delivery and backup. They should use a separate encrypted filename such as `.credentials.enc`, keep key and ciphertext backups separate, and restore them as one pair.

Slark's cloud bundle selects this mode. Every Runtime Cell receives its own deployment-owned key through a systemd credential and writes only ciphertext under its isolated DSH home. The remote-only bundle continues to omit local shell, subprocess, and filesystem providers: encryption at rest does not stop a same-UID process that can deliberately read both the ciphertext and the key.

## Consequences

- Models onboarding and `credentials.set` remain the only user workflow; describe/list responses still disclose presence and source, never values.
- Plaintext local installs retain their existing path, format, and hot-reload behavior.
- Encrypted writes preserve YAML semantics in memory, but external editors see an opaque authenticated envelope.
- An older binary can roll back safely because Slark uses a distinct encrypted filename. Stored credentials are temporarily unavailable to that build and return when the encrypted-capable build is restored.
- Key replacement alone is not rotation. The old key must remain available until the document is deliberately re-encrypted or users have re-entered their credentials.
- This protects durable state and backups; it is not an OS-keychain boundary. A future provider may use platform keychains when same-UID hostile-code isolation is required.

## Alternatives considered

**Encrypt every local credential document by default.** Rejected because it introduces key management for every desktop user, changes the existing format, and makes rollback ambiguous.

**Put the key in an environment variable.** Rejected because environment dumps and child-process inheritance are common disclosure paths; the deployment already has a file-based systemd credential channel.

**Overwrite `.credentials.yaml` with ciphertext.** Rejected because a rollback build would try to parse the encrypted envelope. A distinct path produces an explicit availability loss instead of format confusion.

**Reuse a Slark application or service secret.** Rejected because credential-store compromise would then cross a trust boundary and could affect Slark authentication or other users. Each Runtime Cell receives an independent encryption key.

**Treat encryption as protection from local agent tools.** Rejected because a same-UID process that can read both files can decrypt them. Slark's cloud boundary therefore also requires the remote-only tool preset.
