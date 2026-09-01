# Slark collaboration network Cordis boundary

REQ-20260828-0018 adds `packages/slark/collaboration-network` as an ordinary
Cordis service mounted only by the Slark cloud bundle. It does not modify the
Agent loop or Session format.

The Slark Server is the authority and scheduler. A Runtime Cell presents its
existing short-lived owner subject token and the service bearer. The Server
then performs the owner/personal-project/environment/binding/formal-Agent fence
inside the claim transaction. The shared service bearer alone cannot choose a
different owner's Agent.

The plugin uses AgentRegistry's public create/resume/followup/whenIdle surface.
Project sessions are deterministic and preset-mounted before publication, so a
restart resumes the same durable conversation under the same composition.
Only explicit input text enters the model; raw subject/service credentials and
the full authority document never do.

Thread projection precedes terminal success. Failures produce a fenced failed
receipt when the lease is still usable; unknown transport outcomes remain
bounded by the lease and are not translated into success.
