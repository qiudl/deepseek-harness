# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

This package fills `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` only when `DSH_CLIENT_BUILD_PROFILE` is `official`. A build with `DSH_CLIENT_SLARK_WORKBENCH=1` also fills `sidebar.footer.action` with an “Enterprise workbench” link whose exact `slark-workbench://switch/slark` navigation signal is accepted by Slark Desktop. Builds without either selector leave the corresponding slots empty.

The three official occupants install as one declaration-aware registration set through nested `slots.inject()` calls. The Slark return action installs independently so a cloud workbench does not inherit official DeepSeek branding. Both registrations work whether their row activates before or after the slot declarers and withdraw on HMR teardown. The package retains no runtime state. The node half is an empty Loader seat, and the browser title remains a build-environment concern outside this package.

## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The package supplies fixed deployment occupants** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The Slark link requires its Desktop host** — ordinary browser builds keep `DSH_CLIENT_SLARK_WORKBENCH` unset and never render the custom-protocol action.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.
