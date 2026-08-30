# `@deepseek-ai/dsh-plugin-catalog-file`

English | [中文](README.zh.md)

Cordis filesystem provider for `pluginCatalog`. It loads a deployment-owned absolute manifest, validates every contained YAML file without following paths outside the snapshot root, verifies the resulting content against the manifest's pinned `expectedRevision`, and publishes the complete snapshot atomically.

The required colocated `plugins.json` registry contributes npm package names only, enabling accurate installed-state filtering. Repository URLs must match accepted YAML entries; mappings never make an entry trusted or install it. Missing or mismatched registry data fails startup rather than publishing misleading installed state.

## Model Experience

None. This provider does not register model tools.

## Known Limitations and Deferred Work

- Refresh currently happens at Cordis plugin startup; deployment publishes a new immutable directory and restarts the owning Cell.
