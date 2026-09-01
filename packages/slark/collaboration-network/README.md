# @deepseek-ai/dsh-slark-collaboration-network

English | [中文](README.zh.md)

This Cordis plugin turns configured DSH formal Agents into fenced workers for
Slark collaboration invocations. It is mounted by the `slark-cloud` bundle and
is disabled unless `DSH_SLARK_COLLABORATION_V2=1`.

Each roster entry contains a stable UUID, an Agent preset, and optionally a
dedicated authority session id. The worker obtains the short-lived owner subject
from `slarkIdentity`; the subject token is never stored in plugin configuration,
logs, prompts, URLs, or receipts. Slark restricts every claim to that owner,
personal project, environment, active binding, and exact formal Agent.

The execution session id is deterministic over project, connection, policy
epoch, and formal Agent. Existing persisted sessions are resumed with their
recorded preset; new sessions mount the configured preset before publication.
The result is projected into the envelope's explicit Thread scope before the
terminal receipt is submitted. A transport or execution ambiguity is never
reported as success.

Trusted Cordis integrations can use `ctx.slarkCollaborationNetwork.dispatch()`
for DSH-to-Slark calls. The service verifies that the envelope source is one of
the configured formal Agents and submits it with fresh owner authority.
For a verified DSH human session, `dispatchHuman()` additionally requires the
short-lived Edge-issued actor assertion; Slark binds that JWS to the same
subject session and active caller-target grant before admission.
The browser obtains it from the same-origin Edge endpoint
`POST /api/slark/v1/collaboration/actor-assertions` with the DSH CSRF header;
the Edge derives user, project, environment, and session claims from its HTTP
session. A trusted integration forwards the returned JWS in memory to
`dispatchHuman()` and must never persist it or place it in a URL or prompt.

## Model Experience

Indirectly, through verified invocation input delivered to the selected formal Agent preset.

#### KV Cache effect

Project sessions preserve their own conversation history; different projects, connections, policy epochs, and formal Agents never share a session id.

## Known Limitations and Deferred Work

- Version 1 accepts bounded text input only; attachments require a future
  content-reference contract.
- Roster authoring remains deployment-owned configuration. This package owns
  worker execution, not the user-facing roster editor.
