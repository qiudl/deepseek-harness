SELECT session_key AS id, version, created_at, cwd, parent_session, seed_length, origin,
       delegation_depth, agent_preset, scope_provider, scope_ref, scope_version, incarnation, revision
FROM sessions
WHERE session_key = ?;
