# @deepseek-ai/dsh-tool-plugin-catalog

English | [中文](README.zh.md)

Read-only model-facing discovery over `ctx.pluginCatalog`. `plugin_search` accepts a bounded structured query intent and returns entries from the current validated catalog revision. It cannot install, execute, or synthesize a plugin source.

The tool rejects undeclared intent fields before querying the service. Returned JSON includes `revision`, `generatedAt`, `stale`, the matching catalog entries, and an opaque revision-bound cursor. Catalog membership is not a security endorsement.

## Model Experience

### Tool schema

The model sees one `plugin_search` tool with optional keyword, category, source-kind, ordering, cursor, and limit fields. The fixed schema adds a small stable prefix cost while the tool is visible.

### Tool-call history and result

The query intent remains in tool-call history. The result is compact JSON sourced entirely from `ctx.pluginCatalog`; its token cost scales with the bounded page size. Stable tool definitions preserve KV-cache reuse until plugin composition changes.

## Known Limitations and Deferred Work

- Natural-language quality depends on the active model selecting useful structured filters; no second intent model is used.
- M1 is read-only. Installation requires the separately reviewed trusted confirmation and Cell installer protocol.
- Installed-state filtering stays on the trusted Host gateway and is intentionally absent from model-authored input.
