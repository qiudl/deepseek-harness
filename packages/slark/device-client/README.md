# @deepseek-ai/dsh-slark-device-client

English | [中文](README.zh.md)

Internal Slark Device Gateway client for a DeepSeek Harness runtime cell. The plugin registers `ctx.slarkDevice`; capability providers use it to create one durable Device Task, poll that same logical task, and receive digest-verified output.

```ts ignore-check
import SlarkDeviceClient from '@deepseek-ai/dsh-slark-device-client'

await ctx.plugin(SlarkDeviceClient, {
  gatewayUrl: 'https://slark.example.com',
  serviceToken: process.env.SLARK_DSH_SERVICE_TOKEN,
})

ctx.slarkDevice.bindAuthority(async () => currentSlarkAuthority())
```

## Behavior

- The identity adapter supplies a fresh short-lived subject token plus session, computer, workspace, Grant, and epoch fences for every operation. A `web_dsh_v1` request additionally requires matching v2 authority, assignment, policy, broker, and selection-publication fences; only filesystem capabilities and operations pass. Tokens stay in headers or request bodies and never enter URLs or errors.
- An ambiguous task-creation timeout or transport failure retries the same request body and idempotency key. Once the Gateway returns a task ID, all transport retries query that task; the client never creates a replacement logical task.
- Status pages must be contiguous stdout chunks. The client validates sequence, byte offset, per-chunk SHA-256, complete-result SHA-256, output-gap flags, task lifetime, and configured retention bounds before returning bytes.
- Caller cancellation sends a best-effort cancel for a known task. The server-side task expiry and Device execution lease remain the bounded stop guarantee when the cancel exchange cannot complete.
- There is no local execution fallback. Missing identity, changed workspace authority, malformed Gateway data, output gaps, and digest failures all fail closed with `SlarkDeviceClientError`.

## Model Experience

Indirectly, through capability providers that turn its stable transport failures into model-visible permission, cancellation, or I/O results.

#### KV Cache effect

No direct prompt impact. Provider results retain their existing schemas.

## Known Limitations and Deferred Work

- The package expects an internal Gateway origin and service bearer provisioned by the deployment; it is not a browser client.
- The later identity plugin owns subject-token acquisition and refresh. Loading this client alone leaves every operation unavailable.
- Device output is bounded by `maxResultBytes`; larger artifacts must use the task-scoped artifact path rather than stdout.
