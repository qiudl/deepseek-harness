# Agent Note: Explicit Darwin native target

Status: implemented

English | [中文](2026-09-19-explicit-darwin-native-target.zh.md)

## Problem

An x64 Node process running through Rosetta does not require Apple's universal `cc` driver to select x86_64 output. On an Apple Silicon builder, compiling the declared `darwin-x64` addon without an explicit target can therefore produce an arm64 Mach-O bundle. The platform-package prepack check correctly rejects that mislabeled binary, so a consumer cannot assemble a genuine Intel runtime on that builder.

## Decision

The native-system builder passes clang an explicit Darwin `-arch` value derived from the Node process architecture: `arm64` maps to `arm64`, and Node `x64` maps to clang `x86_64`. Any other macOS architecture fails before compilation. Linux compiler arguments are unchanged.

The mapping is a separately tested function. The existing platform-package verification remains the independent artifact check for the resulting Mach-O CPU type and bundle file type.

## Alternatives considered

**Infer the target from the physical machine.** Rejected because a release may intentionally run an x64 Node process through Rosetta on Apple Silicon. The Node process architecture names the package being built.

**Rely on Rosetta to influence `cc` defaults.** Rejected because Apple's universal compiler still selected arm64 in the affected release environment.

**Disable the platform-package architecture check.** Rejected because that would publish an arm64 binary under the Intel package name and defer failure to consumers.

## Consequences

One Apple Silicon builder can produce either declared macOS addon when the build runs under the matching Node architecture. Compiler target selection is deterministic and fails closed for unsupported Node architectures. macOS builds depend on clang accepting the standard `arm64` and `x86_64` target names.

## Verification

The compiler-target unit test pins both supported mappings and the unsupported-architecture failure. Native package tests continue to reject a Mach-O CPU type that disagrees with package metadata. The formal Intel Desktop assembly exercises the x64 compiler path and its prepack verification.
