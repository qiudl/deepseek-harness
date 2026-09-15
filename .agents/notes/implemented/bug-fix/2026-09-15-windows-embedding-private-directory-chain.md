# Agent Note: Create the Windows embedding private directory chain in order

Status: implemented

English | [中文](2026-09-15-windows-embedding-private-directory-chain.zh.md)

## Problem

The native Windows private-directory operation creates one directory and fails when its immediate parent is absent. A fresh Desktop installation supplies a deep environment path below an application directory that may not exist, so installation identity preparation can fail before any DSH storage is created.

## Decision

Identity preparation receives both the private DSH storage root and the selected environment root. It creates only the storage root's ordinary application parent recursively, then uses the native SID-private operation to create and verify the storage root, its `environments` child, the SHA-256-named environment root, and the identity child in order. The environment root must be the direct namespaced child of the supplied storage root.

## Alternatives considered

**Create the environment root recursively with ordinary filesystem APIs.** Rejected because intermediate DSH directories would bypass native owner, DACL, and reparse-point verification.

**Apply the private DACL to every ancestor up to the drive root.** Rejected because DSH does not own OS and user-profile directories and must not change their access policy.

## Consequences

A first launch can create an absent DSH hierarchy without weakening the private-storage checks. Existing safe directories remain reusable; an environment outside the supplied storage namespace or any unsafe private-directory evidence still fails before identity files are accepted.
