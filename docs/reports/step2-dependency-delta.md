# Step2 dependency delta

English | [中文](step2-dependency-delta.zh.md)

The first dependency checkpoint aligns the Agent package with `dsh-v0.2.2-alpha.2` for the proposed Agent-owned model projection. Existing fork dependencies remain present. The lockfile was regenerated offline; no package version field changed.

| Change | Package | Dependency | Previous | Result | Reason |
| --- | --- | --- | --- | --- | --- |
| Added | `packages/core/agent` | `@deepseek-ai/dsh-brand` | absent | `workspace:*`, linked to `packages/util/brand` | Upstream Agent projection imports the brand helper. |
| Added | `packages/core/agent` | `zod` | absent | `4.4.3` | Upstream Agent model-selection projection validates state with Zod. |

No dependency was upgraded, downgraded, or removed. Zod 4.4.3 was already in the lockfile; this change adds an importer reference rather than a new package version. Further dependency changes need their own recorded delta and validation.
