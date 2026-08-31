# Agent Note: Slark local collaboration for the DSH Web profile

Status: implemented

English | [中文](2026-08-30-slark-local-collaboration.zh.md)

## Problem

Slark Desktop can switch from an enterprise workspace into a personal DSH workbench, but a fixture page cannot represent the product boundary. The formal DSH Web runtime runs on the user's computer and owns local model credentials and compute, while Slark owns enterprise membership, the one personal project for each enterprise and user, and the selected collaboration context. The two applications need an authenticated same-host protocol without turning DSH into an enterprise-hosted runtime or making Slark the owner of model tokens.

## Decision

The Web bundle conditionally composes `@deepseek-ai/dsh-slark-local-collaboration` when its launcher supplies a Slark installation identity, Unix socket path, and local access-key path. Ordinary `dsh web` omits the row and remains independently usable.

The DSH process registers its exact loopback Web origin through Slark's newline-delimited local discovery protocol. It proves possession of the shared key with HMAC-SHA-256 over the request, process identity descriptor, sorted capabilities, fresh process nonce, and daemon challenge. Slark owns native peer-process verification; DSH accepts only the matching ACP initialization and versioned enterprise-context frames. Both sides acknowledge each context transition before Desktop presents it as applied.

The accepted enterprise, personal-project, and environment identifiers enter DSH as dynamic system context and trusted `DSH_*` shell variables. They do not replace the local workspace, local filesystem providers, model credentials, or compute providers. Enterprise names are JSON-encoded and the model text labels the record as data rather than instructions. Disconnect and malformed-frame paths clear the context before retrying, so revoked authority cannot remain model-visible merely because the local socket disappeared.

The Desktop launcher must bind the formal Web runtime to `127.0.0.1` and identify a dedicated DSH executable in production. The local development composition may trust its Node executable to exercise the real protocol, but that value is not a production installation identity.

The same authenticated connection advertises `token_cost_observability_v1`. A Slark-owned `llm/stream` interceptor appends `slark/invocation-start` with route, attempt number, and the immutable authenticated binding snapshot, flushes it, and only then constructs the downstream stream. That marker—not `step/start` or `request/*`—is the coverage denominator. Provider usage is projected without content for each dispatch attempt, so retries remain separately billable. The daemon ACK arrives only after durable acceptance; DSH appends `slark/usage-ack`, and a bounded persisted-session scan replays cold unacknowledged revisions after reconnect. The wire allowlist excludes prompts, responses, tools, files, credentials, and provider error text.

## Alternatives considered

**Keep a Desktop-owned fixture page.** Rejected because it proves navigation chrome but not DSH startup, session UI, context acknowledgement, or use of the formal Harness runtime.

**Host DSH inside the enterprise Slark service.** Rejected because it moves personal model credentials and compute into enterprise infrastructure, contradicting the personal-computer workbench boundary.

**Load enterprise Slark pages directly inside DSH.** Rejected because enterprise project navigation belongs to Slark and would couple the personal workbench to Slark's renderer and authentication internals instead of the agent collaboration protocol.

**Treat the enterprise personal project as a remote filesystem or token pool.** Rejected because the project is collaboration authority and routing context. Local DSH execution remains on the user's computer.

**Infer dispatch from `step/start` or request metadata.** Rejected because a durability-checkpoint failure prevents the Provider call after those events already exist. A product-owned pre-dispatch marker and flush keep the coverage denominator factual.

**Collapse retries into one step total.** Rejected because Provider retries are independently billed. Attempt identity and retry boundaries preserve their separate evidence.

## Verification

The package protocol test runs the registration challenge, proof, ACP initialization, context application, usage delivery, and both acknowledgements over a real Unix socket. Projection tests pin same-attempt last-wins usage, retry separation, missing-usage coverage, ACK suppression, and the zero-content allowlist. The shipped composition build includes the opt-in row while a normal Web profile leaves it disabled. Local product acceptance launches the formal built Web profile, opens it from the installed Slark Desktop, switches between two enterprise personal-project contexts, and returns to the selected Slark enterprise page.

## Consequences

Slark and DSH now retain separate product and resource ownership while sharing one authenticated collaboration context and content-free cost evidence. The cost is a three-process lifecycle—Desktop, daemon, and DSH Web—a launcher contract that must keep the socket, key, installation identity, executable identity, and loopback origin aligned, and append-only acknowledgement records in session history. Losing that alignment makes DSH unavailable to Slark but does not prevent standalone DSH use. The evidence path deliberately performs no prompt or cache optimization; that remains a later, data-gated decision.
