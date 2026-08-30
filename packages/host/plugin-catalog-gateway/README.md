# `@deepseek-ai/dsh-host-plugin-catalog-gateway`

English | [中文](README.zh.md)

Read-only Cordis Remote gateway for plugin-market clients. It projects the active `pluginCatalog` revision and computes installed matches from configured Cordis Loader module names plus catalog-validated package mappings. Clients cannot submit installed entry IDs.

## Model Experience

None. The gateway serves trusted browser clients; the model-facing tool is a separate Cordis plugin.

## Known Limitations and Deferred Work

- Entries without a verified package mapping cannot be reported as installed.
