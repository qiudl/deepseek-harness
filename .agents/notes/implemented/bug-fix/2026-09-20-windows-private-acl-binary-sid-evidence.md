# Agent Note: Decode private-path security evidence from binary SIDs

Status: implemented

English | [中文](2026-09-20-windows-private-acl-binary-sid-evidence.zh.md)

## Problem

The Windows Host registration filesystem adapter decoded handle-derived security evidence from the SDDL text produced by ConvertSecurityDescriptorToStringSecurityDescriptorW. That API serializes well-known SIDs as alias strings: under the built-in Administrator account (RID 500), both the owner and the current-user ACE trustee arrive as "LA", which can never equal the caller's canonical S-1-5-21-<machine>-500 string, so a legitimate private directory was rejected and DSH bootstrap reported an unverified runtime. Ordinary local accounts (any other RID) keep their full SID in SDDL text and were unaffected, which is why the defect only surfaced on RID 500 machines.

## Decision

The adapter now reads the descriptor's binary form: GetSecurityDescriptorControl supplies the DACL-protected flag, GetSecurityInfo's owner and DACL pointers are enumerated with GetAce, and every trustee SID is rendered through ConvertSidToStringSidW, which always emits the canonical numeric form. ACE type, flags, and mask are read directly from the ACE header, so the SDDL rights-token table and its alias normalization disappear entirely. ACEs of any type other than ACCESS_ALLOWED_ACE or ACCESS_DENIED_ACE reject the evidence, and a null DACL reads as an empty access list so the existing three-entry private check still fails closed.

## Alternatives considered

**Normalize the "LA" alias in the SDDL text decoder.** Rejected because an alias-to-SID mapping cannot be hardcoded: the S-1-5-21 machine prefix that "LA" expands to differs per machine and domain, so the text path would still need a native round-trip (ConvertStringSidToSidW plus ConvertSidToStringSidW) for every unknown trustee — the same native dependency with an extra parsing layer that has already produced one aliasing bug.

**Compare trustees as binary SIDs against a binary form of the expected SID.** Rejected as a broader rewrite: the evidence contract exposes SID strings to its consumers, and string comparison is exact once both sides come from ConvertSidToStringSidW.

## Consequences

Private-directory admission no longer depends on SDDL alias behavior, so RID 500 accounts, ordinary accounts, and any future well-known-SID alias decode identically. The koffi binding surface swaps ConvertSecurityDescriptorToStringSecurityDescriptorW for GetSecurityDescriptorControl, GetAce, and ConvertSidToStringSidW; the regression specs model addressable native memory (SECURITY_DESCRIPTOR control word, ACL header, inline ACE SIDs) instead of SDDL strings, verified against the real Win32 behavior on Windows x64.
