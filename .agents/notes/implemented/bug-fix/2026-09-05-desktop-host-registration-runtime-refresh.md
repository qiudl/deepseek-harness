# Agent Note: Desktop Host registration follows runtime upgrades

Status: implemented

English | [中文](2026-09-05-desktop-host-registration-runtime-refresh.zh.md)

## Problem

The owner-only DSH Host discovery record pins the packaged Node executable digest. A Desktop upgrade changes that digest while preserving the Host installation identity, endpoint registration, public key, and socket path. Treating every digest difference as an external-owner conflict prevents the upgraded Host from starting even after it acquires the exclusive Host lock.

## Decision

Host startup accepts an existing discovery record only when its exact field set is valid and its installation id, installation public key, endpoint registration id, and socket path match the starting Host. After exclusive Host ownership is acquired, startup atomically replaces a valid prior executable digest with the digest supplied by the trusted embedding application.

Malformed records, changed identity fields, changed endpoint or socket ownership, symlinks, unexpected fields, and non-owner-writable files remain fail-closed. Runtime rotation does not weaken single-Host ownership or native peer attestation: discovery clients verify the newly published digest against the process that owns the socket.

## Testing

The macOS startup composition test closes one Host, changes only its executable digest, restarts it, and requires the discovery record to contain the replacement digest. The same test continues to reject a second live Host, a different installation id, and a symlink-substituted record.

## Alternatives considered

**Delete the discovery record from Desktop before every launch.** Rejected because Desktop would bypass the Host package's owner, format, identity, and atomic-write checks and could erase evidence of a real ownership conflict.

**Keep every digest difference as a conflict.** Rejected because executable rotation is an ordinary signed Desktop upgrade, while the exclusive Host lock and unchanged installation identity already distinguish it from a second owner.

**Accept changes to every discovery field after taking the lock.** Rejected because the lock protects one Host root, not an unrelated installation, endpoint, key, or socket identity in the shared discovery location.

## Consequences

Signed Desktop upgrades can start the existing Host installation without manual discovery-file cleanup. A changed identity, endpoint, key, socket path, malformed digest, or unsafe file still blocks startup, and clients observe the replacement digest only through an atomic file update.
