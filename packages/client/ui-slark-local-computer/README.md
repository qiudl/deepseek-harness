# `@deepseek-ai/dsh-client-ui-slark-local-computer`

English | [中文](README.zh.md)

Browser presentation plugin for the Slark Web DSH local-computer target. It occupies `sidebar.footer.action`, shows the selected computer and granted workspace without exposing opaque identifiers, and opens an explicit target picker.

## Behavior

- The plugin reads targets from the same-origin Slark Edge API on mount, window focus, picker open, and a 15-second status interval. Responses are byte-bounded and exact-field validated.
- A user confirmation sends one `PUT` with the selected Grant and current publication version. A CAS conflict refreshes the list and requires another confirmation; the client never retries or chooses a target automatically.
- Successful changes honor Edge's `reload_required` result. Edge owns durable selection and Runtime Cell replacement; component state owns only the open picker and current candidate.
- The connection service supplies CSRF-authenticated same-origin requests. Neither credentials nor computer, Grant, or assignment identifiers enter visible errors.

## Model Experience

### Local-computer target controls

#### What the model sees

No prompt section, tool schema, or tool result. The selected `web_dsh_v1` target determines which Slark remote filesystem serves existing file operations, but this presentation plugin adds no model-visible content.

#### Token effect

None directly. File-operation results are produced by the filesystem provider and retain that package's token behavior.

#### KV Cache effect

The plugin does not alter the prompt prefix or previous messages. An Edge-requested page reload may replace the Runtime Cell, but this package adds no cacheable content.

## Known Limitations and Deferred Work

- The first release supports explicit selection only. Grant creation, renewal, and revocation remain Slark Desktop workflows.
- Availability polling is page-local; push updates may replace it after the Edge exposes a non-sensitive event stream.
