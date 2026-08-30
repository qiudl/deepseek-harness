# `@deepseek-ai/dsh-client-ui-settings-plugin-market`

English | [中文](README.zh.md)

Cordis client plugin contributing a lazy `market` tab to `settings.plugins.tab`. Search, category, source, prebuilt distribution, installed state, sorting, pagination, and detail state use the read-only catalog Remote; user-visible filters are reflected in namespaced URL parameters. “Prebuilt” means an npm package or declared release archive and never claims lifecycle scripts are absent.

M1 deliberately exposes no install action. Catalog membership is shown as a candidate, not a security endorsement.

## Model Experience

None. This package is a browser slot contribution.

## Known Limitations and Deferred Work

- Installation and trusted confirmation are deferred to the Runtime Cell installer milestone.
