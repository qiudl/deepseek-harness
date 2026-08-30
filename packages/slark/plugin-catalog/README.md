# `@deepseek-ai/dsh-plugin-catalog`

English | [中文](README.zh.md)

Validated snapshots of the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) directory for Slark Runtime Cells. The package parses a complete revision before publishing it; a failed refresh leaves the previous snapshot unchanged.

## Snapshot input

`buildCatalogSnapshot()` accepts one 40-character Git commit, one valid generation time, and the complete set of YAML source files. A snapshot accepts at most 20,000 `.yml` files, 8 KiB per file, and 32 MiB in total. YAML aliases, merge keys, duplicate keys, unknown fields, control characters, bidirectional controls, duplicate repositories, and invalid GitHub repository paths fail the complete refresh.

Each normalized entry exposes a stable `entryId`, ASCII `ownerName`, exact HTTPS GitHub repository, category, plain-text Chinese or English descriptions, an optional declared tarball URL, an optional repository-verified package name, and `catalog_candidate` installability. Catalog membership is not a security review; consumers must present that distinction and revalidate install sources before any write operation.

## Publication

`CatalogSnapshotStore.refresh()` validates and constructs the complete immutable value before replacing `current()`. The revision is SHA-256 over the source commit and canonical sorted entries, so input file order cannot change identity. The generation time reports freshness but does not change the revision.

## Querying

`queryCatalog()` applies natural-language terms, category, source-kind, and installed-state filters to one supplied snapshot. Search extracts normalized words and CJK bigrams from a request, then scores matches in owner names and plain-text descriptions; equal scores use owner/name and entry identity as deterministic secondary keys. Opaque cursors bind their offset to the snapshot revision and fail when reused against another revision. Results older than 24 hours carry `stale: true` while preserving their actual generation time.

## Model Experience

None, as this package only validates catalog data; a separate consumer decides whether and how entries reach a model request.

#### KV Cache effect

None directly. Snapshot refreshes do not enter a model request through this package.

## Known Limitations and Deferred Work

- **Discovery-only identity** — The first catalog version accepts GitHub repositories, GitHub-hosted declared tarballs, and repository-verified npm names for inventory matching. Install-source verification belongs to the installation coordinator.
