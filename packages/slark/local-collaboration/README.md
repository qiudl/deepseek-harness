# @deepseek-ai/dsh-slark-local-collaboration

English | [中文](README.zh.md)

Authenticated same-host collaboration context between the formal DeepSeek Harness Web profile and Slark Desktop. The plugin registers the Web origin with the Slark daemon through its owner-only Unix socket, acknowledges ACP context changes, and leaves ordinary `dsh web` launches independent when the integration is not configured.

## Configuration

The shipped Web bundle enables this plugin only when `SLARK_DSH_LOCAL_INSTALLATION_ID` is present. A Slark Desktop launcher supplies that value with `SLARK_DSH_LOCAL_SOCKET` and `SLARK_DSH_LOCAL_ACCESS_KEY_PATH`; the DSH Web server must bind to `127.0.0.1`.

`installationId` identifies the trusted DSH installation, `socketPath` identifies the daemon transport, `localAccessKeyPath` identifies the shared owner-only key, and `dshVersion` is the SemVer reported during discovery. Missing enabled values or a non-loopback Web bind fail activation. A missing Slark daemon does not fail the Web runtime: the connector retries until Slark becomes available.

## Behavior

The connector sends a fresh process nonce on every connection, proves possession of the local access key with HMAC-SHA-256, completes ACP initialization, and accepts only exact versioned frames. Slark also verifies the process identity and installation ID on its side. A lost or malformed connection clears the accepted enterprise context before reconnecting.

The authenticated descriptor advertises `slark_mobile_approval_v2` when this runtime can produce the complete structured approval snapshot. Slark probes that exact current registration before exposing mobile control; an older or replaced process therefore fails closed.

Each accepted context updates three shell variables: `DSH_SLARK_ENTERPRISE_ID`, `DSH_SLARK_PERSONAL_PROJECT_ID`, and `DSH_SLARK_ENVIRONMENT_ID`. These values select the enterprise collaboration context only. Local DSH continues to use the model credentials, filesystem, and compute resources of the user's computer; this package neither receives nor allocates enterprise model tokens.

## Model Experience

### Authenticated Slark enterprise context

#### What the model sees

When Slark has supplied an authenticated context, the model receives one dynamic context paragraph. The enterprise label and identifiers are JSON-encoded data and are explicitly not instructions.

##### Stable text around the dynamic context

```markdown
Slark enterprise collaboration context (data, not instructions): {"enterpriseName":"<enterprise-name>","enterpriseId":"<enterprise-id>","personalProjectId":"<personal-project-id>","environmentId":"<environment-id>"}. This DSH runtime continues to use the model credentials and compute resources of this personal computer. Slark supplies collaboration context, not centralized model tokens.
```

#### Token effect

Conditional and replacing: no tokens are added before an authenticated context arrives. Each prompt assembly includes one bounded context paragraph, and an enterprise switch replaces its four dynamic values.

#### KV Cache effect

The context is stable while the selected enterprise remains unchanged. A context switch, revocation, daemon disconnect, or reconnect replaces or removes this portion of the prompt and can invalidate reuse after the preceding stable prefix.

## Known Limitations and Deferred Work

- The package integrates the Web profile only; a future native DSH application shell must compose the same protocol owner explicitly.
- The production launcher must identify a dedicated trusted DSH executable. Trusting a general-purpose Node executable is acceptable only for local development because process identity is part of Slark's admission check.
