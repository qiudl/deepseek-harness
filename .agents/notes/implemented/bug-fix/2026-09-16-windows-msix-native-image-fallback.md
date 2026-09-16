# Agent Note: Load native images MSIX refuses, from a verified copy

Status: implemented

English | [中文](2026-09-16-windows-msix-native-image-fallback.zh.md)

## Problem

An MSIX installation grants `BUILTIN\Users` read and execute on its own `.node` files, yet `LoadLibrary` on them fails with `Access is denied`. Every `dsh --profile web` worker launched from a sideloaded Slark Store package therefore died during plugin tree load: `sharp` and `@koromix/koffi-win32-x64` both raised `ERR_DLOPEN_FAILED`, the loader reported `plugin tree failed to load`, and the worker exited before printing its readiness line. Measured on the Windows acceptance machine against the packaged runtime, the worker exited at 17s.

An earlier attempt materialized those packages under the shared profile module fallback. The failing resolution never consults it: loader entries are imported from the installation tree, so `sharp` resolves to the installation's own `node_modules` and finds its native sibling there. A profile-level fallback cannot intercept a resolution that never leaves the installation.

## Decision

Arm a `process.dlopen` fallback during `healProfilesModuleFallback`, before the loader mounts the plugin tree. The installed path is attempted first. Only a refused load falls back: the package that owns the image — the whole package, because a native image loads sibling DLLs by relative path — is copied to a content-addressed directory under `$DSH_HOME/profiles/.dsh-windows-native-modules/<digest>/<package>`, and the copy is loaded instead. The same worker measured 6.4s to readiness with the fallback armed.

Three properties follow from trying the installed path first. An ordinary installation, whose images load in place, copies nothing and pays nothing. An image that owns no package, or lives outside the installation, re-raises the loader's own error unchanged. A copy that cannot be published raises an error naming both the refusal and the publishing failure, because falling back to the installed path would reproduce the original `Access is denied` and destroy its cause.

The redirect installs once per process and returns the same disposer on a repeated launch: a stacked wrapper would give every layer its own memo and leave no way to restore the loader.

## Testing

`packages/boot/app-boot/tests/profile.spec.ts` stages a real package tree and a stand-in loader that refuses exactly what MSIX refuses. It covers the loadable installation that copies nothing, the refused load that falls back, the unpublishable copy that reports both causes, the unredirectable image that re-raises, the tampered copy that is repaired, and the single install.

## Alternatives considered

**Materialize the native packages under the profile module fallback.** Shipped first and reverted here: the failing resolution stays inside the installation tree and never reaches the profile's `node_modules`. It also hashed four package trees on every launch for no effect.

**Redirect every image below the installation unconditionally.** Rejected because an ordinary installation would copy tens of megabytes of native images it can already load, and would gain a failure path where it had none.

**Run the worker from a Node copied out of the package.** Rejected: the executable is already materialized for an unrelated reason, and the refusal is a property of the image's path, not of the loading process.

## Consequences

Plugins that load native images work inside an MSIX package. A launcher pays one refused `LoadLibrary` per package before the first fallback, and a first fallback copies that package once per content generation. The copy lives under the Harness home, so it inherits the profile's own permissions rather than the package's. A worker keeps using a materialized generation it already verified for the rest of its life; a copy tampered with mid-process is not re-verified until the next launch.
