import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HOST_CONTROL_MAX_FRAME_BYTES,
  HostControlProtocolError,
  decodeHostControlFrame,
  encodeHostControlFrame,
  encodeHostInspectSignaturePayload,
  canonicalMigrationRecords,
  migrationProfileSelectorHash,
  migrationSemanticDigest,
} from '../src/index.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

const wire = (value: unknown): string => `${JSON.stringify(value)}\n`

function expectMutationsRejected(source: string, path: readonly string[], values: readonly unknown[]): void {
  for (const value of values) {
    const frame = structuredClone(JSON.parse(source) as Record<string, unknown>)
    let target = frame
    for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>
    target[path.at(-1) as string] = value
    expect(() => decodeHostControlFrame(wire(frame))).toThrow(HostControlProtocolError)
  }
}

describe('Host control protocol golden vectors', () => {
  it('encodes the host.inspect request byte-for-byte', () => {
    const message = decodeHostControlFrame(fixture('host-inspect.request.jsonl'))
    expect(encodeHostControlFrame(message)).toBe(fixture('host-inspect.request.jsonl'))
  })

  it('encodes the host.inspect result byte-for-byte', () => {
    const message = decodeHostControlFrame(fixture('host-inspect.result.jsonl'))
    expect(encodeHostControlFrame(message)).toBe(fixture('host-inspect.result.jsonl'))
  })

  it('encodes a stable error byte-for-byte without leaking arbitrary detail', () => {
    const message = decodeHostControlFrame(fixture('unsupported-protocol.error.jsonl'))
    expect(encodeHostControlFrame(message)).toBe(fixture('unsupported-protocol.error.jsonl'))
  })

  it('pins the exact challenge-signing statement', () => {
    const request = decodeHostControlFrame(fixture('host-inspect.request.jsonl'))
    const response = decodeHostControlFrame(fixture('host-inspect.result.jsonl'))
    if (request.type !== 'request' || request.method !== 'host.inspect'
      || response.type !== 'result' || response.method !== 'host.inspect') throw new Error('fixture type mismatch')
    expect(new TextDecoder().decode(encodeHostInspectSignaturePayload(request, response)))
      .toBe(fixture('host-inspect.signature-payload.jsonl'))
  })
})

describe('Host control frame boundary', () => {
  it('rejects unknown and missing top-level fields', () => {
    expect(() => decodeHostControlFrame('{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3110","method":"host.inspect","params":{},"extra":true}\n'))
      .toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame('{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3110","method":"host.inspect"}\n'))
      .toThrow(HostControlProtocolError)
  })

  it('rejects non-canonical JSON and more than one frame', () => {
    expect(() => decodeHostControlFrame('{ "version": 1 }\n')).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame('{}\n{}\n')).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame('{}')).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame('{}\r\n')).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame('{malformed}\n')).toThrow(HostControlProtocolError)
  })

  it('rejects oversized frames before JSON parsing', () => {
    const oversized = `${' '.repeat(HOST_CONTROL_MAX_FRAME_BYTES + 1)}\n`
    expect(() => decodeHostControlFrame(oversized)).toThrow(HostControlProtocolError)
  })

  it('rejects valid frames with non-canonical key order', () => {
    const original = JSON.parse(fixture('host-inspect.request.jsonl')) as Record<string, unknown>
    const reordered = {
      version: original.version,
      type: original.type,
      method: original.method,
      request_id: original.request_id,
      params: original.params,
    }
    expect(() => decodeHostControlFrame(wire(reordered))).toThrow(HostControlProtocolError)
    const escaped = fixture('host-inspect.result.jsonl').replace('"environment.attach"', '"\\u0065nvironment.attach"')
    expect(() => decodeHostControlFrame(escaped)).toThrow(HostControlProtocolError)
  })

  it('validates outbound values even when a caller bypasses static types', () => {
    const frame = decodeHostControlFrame(fixture('unsupported-protocol.error.jsonl'))
    const forged = { ...frame, leaked_detail: 'local filesystem contents' }
    expect(() => encodeHostControlFrame(forged as typeof frame)).toThrow(HostControlProtocolError)
  })

  it('enforces the byte ceiling after validating a large outbound frame', () => {
    const entry = {
      id: 'a'.repeat(128), name: 'b'.repeat(214), transport: 'c'.repeat(128), plugin_state: 'unsupported',
    }
    const frame = {
      version: 1,
      type: 'result',
      request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3110',
      method: 'profile.extensions',
      result: { state: 'inventory', kind: 'plugin', entries: Array.from({ length: 128 }, () => entry) },
    }
    expect(() => encodeHostControlFrame(frame as never)).toThrow(expect.objectContaining({ code: 'frame_too_large' }))
  })

  it('rejects non-canonical base64url trailing bits', () => {
    const source = fixture('host-inspect.request.jsonl')
      .replace('ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8', 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v9')
    expect(() => decodeHostControlFrame(source)).toThrow(HostControlProtocolError)
  })

  it('lets a future client negotiate down to protocol version 1', () => {
    const source = fixture('host-inspect.request.jsonl').replace('"supported_versions":[1]', '"supported_versions":[2,1]')
    expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
  })

  it('rejects an inspect client that omits protocol version 1', () => {
    const source = fixture('host-inspect.request.jsonl').replace('"supported_versions":[1]', '"supported_versions":[3,2]')
    expect(() => decodeHostControlFrame(source)).toThrow(HostControlProtocolError)
  })

  it('requires the baseline inspect capability and distinct Host identities', () => {
    const missingBaseline = fixture('host-inspect.result.jsonl')
      .replace('"environment.attach","host.inspect",', '"environment.attach",')
    expect(() => decodeHostControlFrame(missingBaseline)).toThrow(HostControlProtocolError)
    const reusedIdentity = fixture('host-inspect.result.jsonl')
      .replace('018f0f4c-87f8-7e2d-a2f8-7b93d34e3121', '018f0f4c-87f8-7e2d-a2f8-7b93d34e3120')
    expect(() => decodeHostControlFrame(reusedIdentity)).toThrow(HostControlProtocolError)
  })

  it('rejects non-objects and every malformed inspect negotiation primitive', () => {
    for (const value of [null, [], true, 1, 'frame']) {
      expect(() => decodeHostControlFrame(wire(value))).toThrow(HostControlProtocolError)
    }

    const request = fixture('host-inspect.request.jsonl')
    expectMutationsRejected(request, ['version'], [0, 2, '1'])
    expectMutationsRejected(request, ['request_id'], [null, 'not-a-uuid'])
    expectMutationsRejected(request, ['params', 'challenge'], [null, 'ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v9'])
    expectMutationsRejected(request, ['params', 'client_instance_id'], [null, '018f0f4c-87f8-0e2d-a2f8-7b93d34e3111'])
    expectMutationsRejected(request, ['params', 'supported_versions'], [
      null,
      [],
      [9, 8, 7, 6, 5, 4, 3, 2, 1],
      ['2', 1],
      [2, 0, 1],
      [1, 1],
      [2, 3, 1],
      [3, 2],
    ])

    const result = fixture('host-inspect.result.jsonl')
    expectMutationsRejected(result, ['result', 'protocol_version'], [0, 2, '1'])
    expectMutationsRejected(result, ['result', 'installation_public_key'], [null, 'EjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJCrze9'])
    expectMutationsRejected(result, ['result', 'runtime_generation'], [null, 0, -1, 1.5])
    expectMutationsRejected(result, ['result', 'schema_generation'], [null, 0, Number.MAX_SAFE_INTEGER + 1])
    expectMutationsRejected(result, ['result', 'process_nonce'], [null, '_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1R'])
    expectMutationsRejected(result, ['result', 'capabilities'], [
      null,
      ['host.inspect', 1],
      ['host'],
      ['host.inspect', 'environment.attach'],
      ['host.inspect', 'host.inspect'],
      ['environment.attach'],
    ])
    expectMutationsRejected(result, ['result', 'challenge_signature'], [null, `${'A'.repeat(85)}B`])
    expectMutationsRejected(result, ['result', 'executable_signature_digest'], [null, 'A'.repeat(64)])
  })

  it('rejects malformed public error frames without reflecting attacker detail', () => {
    const source = fixture('unsupported-protocol.error.jsonl')
    expectMutationsRejected(source, ['method'], [null, 'host', 'Host.inspect'])
    expectMutationsRejected(source, ['error', 'code'], [null, 'filesystem_detail'])
    expectMutationsRejected(source, ['error', 'retryable'], [null, 0, 'false'])
    expectMutationsRejected(source, ['error', 'correlation_id'], [null, 'not-a-uuid'])
  })
})

describe('Main-only Profile operations', () => {
  const auth = '"client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3111","host_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3120","process_nonce":"_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q","jti":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3130","issued_at":1000,"expires_at":2000'

  it('round-trips both legacy and Account-token Profile ensure payloads for safe rolling upgrades', () => {
    const prefix = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.ensure","params":{${auth},"authority_environment_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3181","account_binding_handle":"binding:opaque","authority_binding_version":1,`
    const suffix = '"account_issuer":"https://accounts.dsh.colorbuyai.com","account_subject":"person","profile_key_handle":"keychain:person","profile_unlock_material":"CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"}}\n'
    const legacy = `${prefix}${suffix}`
    const tokenBearing = `${prefix}"account_access_token":"header.payload.signature",${suffix}`
    for (const source of [legacy, tokenBearing]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
    }
  })

  it('round-trips local Profile bootstrap, restore, and open without account fields', () => {
    const selector = `${'A'.repeat(32)}.${'A'.repeat(86)}`
    const bootstrap = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.bootstrap_local","params":{${auth},"profile_key_handle":"keychain:local","profile_unlock_material":"${'A'.repeat(43)}"}}\n`
    const restore = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"profile.restore_local","params":{${auth},"profile_selector":"${selector}","profile_key_handle":"keychain:local","profile_unlock_material":"${'A'.repeat(43)}"}}\n`
    const open = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"profile.open_local","params":{${auth},"profile_selector":"${selector}"}}\n`
    const result = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"profile.bootstrap_local","result":{"state":"ready","profile_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","profile_selector":"${selector}","persistence_generation":1}}\n`
    for (const source of [bootstrap, restore, open, result]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
      expect(source).not.toMatch(/"(?:account|issuer|subject|token|environment)_/u)
    }
    expect(() => decodeHostControlFrame(bootstrap.replace('"profile_key_handle"', '"account_subject":"forged","profile_key_handle"')))
      .toThrow(HostControlProtocolError)
  })

  it('round-trips Profile status, open, activation, and lease close without secret fields', () => {
    const status = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.status","params":{${auth},"authority_environment_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3181","account_binding_handle":"keychain-binding:opaque","authority_binding_version":1}}\n`
    const openRequest = status.replace('"method":"profile.status"', '"method":"profile.open"')
    const restore = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3144","method":"profile.restore","params":{${auth},"authority_environment_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3181","account_binding_handle":"keychain-binding:opaque","authority_binding_version":1,"profile_selector":"${'A'.repeat(32)}.${'A'.repeat(86)}","profile_key_handle":"keychain:person","profile_unlock_material":"${'A'.repeat(43)}"}}\n`
    const open = '{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"profile.open","result":{"profile_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","view_activation_handle":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","lease_generation":2,"expires_at":2000,"runtime_generation":5}}\n'
    const activate = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"profile.view_activate","params":{${auth},"profile_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","view_activation_handle":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","lease_generation":2,"runtime_generation":5}}\n`
    const activated = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"profile.view_activate","result":{"origin":"http://127.0.0.1:4123","activation_generation":7,"expires_at":2000,"bootstrap_cookie":{"name":"dsh-auth-${'a'.repeat(43)}","value":"v1.${'b'.repeat(8)}.${'c'.repeat(43)}"}}}\n`
    const close = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"profile.lease_close","params":{${auth},"view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","lease_generation":2,"runtime_generation":5}}\n`
    const closed = '{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"profile.lease_close","result":{"closed":true}}\n'
    for (const source of [status, openRequest, restore, open, activate, activated, close, closed]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
      expect(source).not.toMatch(/"(?:token|cookie|path|subject)"/)
    }
    expectMutationsRejected(restore, ['params', 'profile_selector'], [null, 'A'.repeat(32), `${'A'.repeat(31)}.${'A'.repeat(86)}`])
    expectMutationsRejected(activate, ['params', 'view_activation_handle'], [null, 'A'.repeat(42)])
    expectMutationsRejected(activated, ['result', 'origin'], [
      null, 'https://127.0.0.1:4123', 'http://localhost:4123', 'http://127.0.0.1:0', 'http://127.0.0.1:65536',
    ])
    expectMutationsRejected(activated, ['result', 'bootstrap_cookie'], [null, [], { name: 'dsh-auth-a', value: 'v1.a.b', extra: true }])
    expectMutationsRejected(activated, ['result', 'bootstrap_cookie', 'name'], [null, 'auth-a'])
    expectMutationsRejected(activated, ['result', 'bootstrap_cookie', 'value'], [null, 'secret', 'v1.a'])
    expectMutationsRejected(closed, ['result', 'closed'], [false, 1, 'true'])
  })

  it('round-trips the offline Account recovery protocol without identity or path fields', () => {
    const handle = 'A'.repeat(43)
    const material = 'A'.repeat(43)
    const digest = 'a'.repeat(64)
    const selector = `${'B'.repeat(64)}.${'A'.repeat(86)}`
    const inspect = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.recovery_inspect","params":{${auth},"profile_key_handles":["${handle}"],"expected_runtime_generation":5,"expected_schema_generation":3}}\n`
    const inspected = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.recovery_inspect","result":{"candidates":[{"state":"recoverable","candidate_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3160","profile_kind":"account","binding_count":1,"persistence_generation":11,"session_count":86,"plugin_count":6,"compatibility":"current","preflight_digest":"${digest}"}]}}\n`
    const recover = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"profile.recover_offline_account","params":{${auth},"profile_key_handle":"${handle}","profile_unlock_material":"${material}","recovery_operation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3170","candidate_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3160","preflight_digest":"${digest}"}}\n`
    const recovered = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"profile.recover_offline_account","result":{"state":"offline_ready","profile_selector":"${selector}","access_scope":"offline_local","persistence_generation":11,"runtime_generation":5}}\n`
    const open = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"profile.open_offline_account","params":{${auth},"profile_selector":"${selector}"}}\n`
    const opened = '{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"profile.open_offline_account","result":{"profile_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","view_activation_handle":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","lease_generation":2,"expires_at":2000,"runtime_generation":5,"access_scope":"offline_local"}}\n'
    const status = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"profile.recovery_status","params":{${auth},"recovery_operation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3170"}}\n`
    const statusResult = '{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"profile.recovery_status","result":{"state":"offline_ready"}}\n'
    const failed = '{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"profile.recovery_status","result":{"state":"failed","reason_code":"recovery_worker_failed"}}\n'
    for (const source of [inspect, inspected, recover, recovered, open, opened, status, statusResult, failed]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
      expect(source).not.toMatch(/"(?:account_subject|account_issuer|path)"/u)
    }
    expectMutationsRejected(inspected, ['result', 'candidates', '0', 'compatibility'], [['current']])
    expectMutationsRejected(statusResult, ['result', 'state'], [['offline_ready']])
    expectMutationsRejected(inspect, ['params', 'profile_key_handles'], [null, [], Array(129).fill(handle), [handle, handle]])
    expectMutationsRejected(inspected, ['result', 'candidates'], [null, [], Array(129).fill({})])
    expectMutationsRejected(failed, ['result', 'reason_code'], [null, 'internal_error'])
    const blockedFrame = JSON.parse(inspected) as {
      result: { candidates: Array<Record<string, unknown>> }
    }
    blockedFrame.result.candidates[0] = {
      ...blockedFrame.result.candidates[0],
      state: 'compatibility_blocked',
      compatibility: 'legacy_runtime_required',
      reason_code: 'legacy runtime required',
    }
    const blocked = wire(blockedFrame)
    expect(encodeHostControlFrame(decodeHostControlFrame(blocked))).toBe(blocked)
    expectMutationsRejected(blocked, ['result', 'candidates', '0', 'state'], [null, 'blocked'])
    expectMutationsRejected(blocked, ['result', 'candidates', '0', 'profile_kind'], [null, 'local'])
    expectMutationsRejected(recovered, ['result', 'access_scope'], [null, 'account'])
    expectMutationsRejected(opened, ['result', 'access_scope'], [null, 'account'])
  })

  it('rejects reordered auth fields and lease results carrying a URL', () => {
    const reordered = '{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.status","params":{"host_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3120","client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3111","process_nonce":"_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q","jti":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3130","issued_at":1000,"expires_at":2000,"account_binding_handle":"binding"}}\n'
    const leaked = '{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"profile.open","result":{"profile_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","lease_generation":2,"expires_at":2000,"runtime_generation":5,"url":"http://127.0.0.1"}}\n'
    expect(() => decodeHostControlFrame(reordered)).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame(leaked)).toThrow(HostControlProtocolError)
  })

  it('rejects invalid authorization lifetimes and Account bootstrap material', () => {
    const source = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.ensure","params":{${auth},"authority_environment_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3181","account_binding_handle":"binding:opaque","authority_binding_version":1,"account_access_token":"header.payload.signature","account_issuer":"https://accounts.dsh.colorbuyai.com","account_subject":"person","profile_key_handle":"keychain:person","profile_unlock_material":"${'A'.repeat(43)}"}}\n`
    expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)

    expectMutationsRejected(source, ['params', 'issued_at'], [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expectMutationsRejected(source, ['params', 'expires_at'], [null, -1, 999, 1000])
    expectMutationsRejected(source, ['params', 'account_binding_handle'], [null, '', 'x'.repeat(513), 'binding\u0000secret'])
    expectMutationsRejected(source, ['params', 'account_access_token'], [null, '', 'x'.repeat(8193), 'token\nsecret'])
    expectMutationsRejected(source, ['params', 'account_subject'], [null, '', 'x'.repeat(513), 'subject\u007f'])
    expectMutationsRejected(source, ['params', 'profile_key_handle'], [null, '', 'x'.repeat(513), 'key\rhandle'])
    expectMutationsRejected(source, ['params', 'profile_unlock_material'], [
      null,
      'A'.repeat(42),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}B`,
    ])
    expectMutationsRejected(source, ['params', 'account_issuer'], [
      null,
      '',
      'not-a-url',
      'http://accounts.dsh.colorbuyai.com',
      'https://user@accounts.dsh.colorbuyai.com',
      'https://user:password@accounts.dsh.colorbuyai.com',
      'https://accounts.dsh.colorbuyai.com?secret=1',
      'https://accounts.dsh.colorbuyai.com#fragment',
      'https://accounts.dsh.colorbuyai.com/path',
      'https://ACCOUNTS.dsh.colorbuyai.com',
    ])
  })

  it('admits only the closed Profile status states and known Profile methods', () => {
    const result = (state: unknown, extra: Record<string, unknown> = {}) => wire({
      version: 1,
      type: 'result',
      request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140',
      method: 'profile.status',
      result: { state, ...extra },
    })
    for (const state of ['unbound', 'locked']) {
      const source = result(state)
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
    }
    const ready = result('ready', {
      profile_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150',
      persistence_generation: 1,
    })
    expect(encodeHostControlFrame(decodeHostControlFrame(ready))).toBe(ready)
    for (const state of [null, ['locked'], 'ready', 'unknown']) {
      expect(() => decodeHostControlFrame(result(state))).toThrow(HostControlProtocolError)
    }
    for (const type of ['request', 'result'] as const) {
      expect(() => decodeHostControlFrame(wire({
        version: 1, type, request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140',
        method: 'profile.unknown', [type === 'request' ? 'params' : 'result']: {},
      }))).toThrow(expect.objectContaining({ code: 'unknown_method' }))
    }

    const selector = `${'A'.repeat(32)}.${'A'.repeat(86)}`
    for (const method of ['profile.ensure', 'profile.restore', 'profile.restore_local'] as const) {
      const local = method === 'profile.restore_local'
      const source = wire({
        version: 1,
        type: 'result',
        request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140',
        method,
        result: {
          state: 'ready',
          profile_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3150',
          profile_selector: selector,
          ...(local ? { persistence_generation: 1 } : {}),
        },
      })
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
      expectMutationsRejected(source, ['result', 'state'], [null, 'locked'])
    }
  })
})

describe('Host inspect signature boundary', () => {
  it('requires inspect request/result roles and one correlation ID', () => {
    const request = decodeHostControlFrame(fixture('host-inspect.request.jsonl'))
    const response = decodeHostControlFrame(fixture('host-inspect.result.jsonl'))
    const error = decodeHostControlFrame(fixture('unsupported-protocol.error.jsonl'))
    expect(() => encodeHostInspectSignaturePayload(error as never, response as never))
      .toThrow(HostControlProtocolError)
    expect(() => encodeHostInspectSignaturePayload(request as never, request as never))
      .toThrow(HostControlProtocolError)
    expect(() => encodeHostInspectSignaturePayload(request as never, {
      ...response,
      request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3198',
    } as never)).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame(wire({ ...request, type: 'notification' })))
      .toThrow(HostControlProtocolError)
  })
})

describe('cross-repository migration digest vector', () => {
  it('sorts records and object keys before hashing', () => {
    const records = [
      { collection: 'sessions' as const, id: 'a'.repeat(32), sequence: 0, payloadDigest: '1'.repeat(64) },
      { collection: 'session_events' as const, id: 'b'.repeat(32), sessionId: 'a'.repeat(32), sequence: 1, payloadDigest: '2'.repeat(64) },
    ]
    expect(canonicalMigrationRecords(records)).toBe('[{"collection":"session_events","id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","payloadDigest":"2222222222222222222222222222222222222222222222222222222222222222","sequence":1,"sessionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"collection":"sessions","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payloadDigest":"1111111111111111111111111111111111111111111111111111111111111111","sequence":0}]')
    expect(migrationSemanticDigest(records)).toBe('bef76f5a2f77877270e332865c7e2bc88b6dd2e83952df2d005461c6b978d4d5')
  })

  it('orders collection ties by id and sequence and rejects non-JSON digest material', () => {
    const records = [
      { collection: 'sessions' as const, id: 'b', sequence: 0, payloadDigest: '3' },
      { collection: 'sessions' as const, id: 'a', sequence: 2, payloadDigest: '2' },
      { collection: 'sessions' as const, id: 'a', sequence: 1, payloadDigest: '1' },
    ]
    expect(JSON.parse(canonicalMigrationRecords(records))).toEqual([records[2], records[1], records[0]])
    expect(() => canonicalMigrationRecords([{
      collection: 'sessions', id: 'b', sequence: 0, payloadDigest: 1n as never,
    }]))
      .toThrow('migration_canonical_non_json_value')
    expect(migrationProfileSelectorHash('selector')).toMatch(/^[0-9a-f]{64}$/u)
    expect(migrationProfileSelectorHash('selector')).not.toBe(migrationProfileSelectorHash('other-selector'))
  })
})

describe('owner-only migration import lifecycle', () => {
  const auth = '"client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3111","host_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3120","process_nonce":"_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q","jti":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3130","issued_at":1000,"expires_at":2000'

  it('requires the signed source Profile selector on export begin and read', () => {
    const selector = `${'A'.repeat(32)}.${'A'.repeat(86)}`
    const begin = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"migration.export_snapshot.begin","params":{${auth},"source_profile_selector":"${selector}","expected_inventory_digest":"${'c'.repeat(64)}","max_records":3,"max_bytes":4096}}\n`
    const inventory = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"migration.export_snapshot.inventory","params":{${auth},"source_profile_selector":"${selector}"}}\n`
    const read = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"migration.export_snapshot.read","params":{${auth},"source_profile_selector":"${selector}","export_id":"${'d'.repeat(48)}","chunk_index":0}}\n`
    for (const source of [inventory, begin, read]) expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
    for (const source of [inventory, read]) {
      const withAuthority = source.replace(`"source_profile_selector":"${selector}"`,
        `"source_profile_selector":"${selector}","source_inventory_authority":"${'A'.repeat(43)}"`)
      expect(encodeHostControlFrame(decodeHostControlFrame(withAuthority))).toBe(withAuthority)
    }
    expect(() => decodeHostControlFrame(begin.replace(`,"source_profile_selector":"${selector}"`, '')))
      .toThrow(HostControlProtocolError)
  })

  it('round-trips a path-free legacy inventory authority and binds it to export calls', () => {
    const selector = `${'A'.repeat(32)}.${'A'.repeat(86)}`
    const authority = 'A'.repeat(43)
    const probe = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3146","method":"migration.existing_source.inventory","params":{${auth},"target_profile_selector":"${selector}"}}\n`
    const result = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3146","method":"migration.existing_source.inventory","result":{"source_inventory_authority":"${authority}","source_installation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3121","expires_at":2000,"inventory_digest":"${'c'.repeat(64)}","source_generation":"${'d'.repeat(64)}","schema_version":0,"required_max_records":4,"required_max_bytes":4096}}\n`
    const begin = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3147","method":"migration.export_snapshot.begin","params":{${auth},"source_profile_selector":"${selector}","source_inventory_authority":"${authority}","expected_inventory_digest":"${'c'.repeat(64)}","max_records":4,"max_bytes":4096}}\n`
    for (const source of [probe, result, begin]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
      expect(source).not.toMatch(/"(?:path|payload|subject|token)"/u)
    }
    expectMutationsRejected(result, ['result', 'source_inventory_authority'], [null, `${'A'.repeat(42)}B`])
    expectMutationsRejected(begin, ['params', 'source_inventory_authority'], [null, `${'A'.repeat(42)}B`])
  })

  it('round-trips stage, verify, commit, and abort without payloads or paths', () => {
    const selector = `${'A'.repeat(32)}.${'A'.repeat(86)}`
    const stage = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"migration.import_snapshot.stage","params":{${auth},"transfer_id":"${'a'.repeat(48)}","transfer_digest":"${'b'.repeat(64)}","source_installation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","source_inventory_digest":"${'c'.repeat(64)}","source_generation":"${'d'.repeat(64)}","source_schema_version":0,"target_generation":5,"target_profile_selector":"${selector}","record_count":3,"semantic_digest":"${'e'.repeat(64)}"}}\n`
    const statusRequest = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3145","method":"migration.import_snapshot.status","params":{${auth},"transfer_id":"${'a'.repeat(48)}","target_generation":5,"source_installation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","target_profile_selector":"${selector}"}}\n`
    const status = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3144","method":"migration.import_snapshot.status","result":{"import_id":"${'f'.repeat(48)}","stage_version":2,"state":"staged","target_generation":5,"record_count":3,"semantic_digest":"${'e'.repeat(64)}"}}\n`
    const verify = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"migration.import_snapshot.verify","params":{${auth},"import_id":"${'f'.repeat(48)}","expected_stage_version":1,"target_profile_selector":"${selector}"}}\n`
    const commit = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"migration.import_snapshot.commit","params":{${auth},"import_id":"${'f'.repeat(48)}","expected_stage_version":2,"expected_current_generation":4,"target_profile_selector":"${selector}"}}\n`
    const abortRequest = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"migration.import_snapshot.abort","params":{${auth},"import_id":"${'f'.repeat(48)}","expected_stage_version":2,"target_profile_selector":"${selector}"}}\n`
    const abort = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"migration.import_snapshot.abort","result":{"import_id":"${'f'.repeat(48)}","stage_version":2,"aborted":true}}\n`
    for (const source of [stage, statusRequest, status, verify, commit, abortRequest, abort]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
      expect(source).not.toMatch(/"(?:payload|path|url|token|cookie)"/u)
    }
  })

  it('round-trips every migration result and rejects forged completion flags', () => {
    const id = 'f'.repeat(48)
    const digest = 'e'.repeat(64)
    const common = {
      version: 1, type: 'result', request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140',
    }
    const frames = [
      { ...common, method: 'migration.export_snapshot.inventory', result: {
        inventory_digest: 'a'.repeat(64), source_generation: 'b'.repeat(64), schema_version: 0,
        required_max_records: 3, required_max_bytes: 4096,
      } },
      { ...common, method: 'migration.export_snapshot.begin', result: {
        export_id: 'a'.repeat(48), transfer_id: 'b'.repeat(48), transfer_digest: 'c'.repeat(64),
        schema_version: 0, source_generation: 'd'.repeat(64), record_count: 3,
        first_event_sequence: 0, last_event_sequence: 2, semantic_digest: digest, chunk_count: 1,
      } },
      { ...common, method: 'migration.import_snapshot.stage', result: {
        import_id: id, stage_version: 1, state: 'staged', target_generation: 5,
        record_count: 3, semantic_digest: digest,
      } },
      { ...common, method: 'migration.import_snapshot.verify', result: {
        import_id: id, stage_version: 2, verified: true, semantic_digest: digest,
      } },
      { ...common, method: 'migration.import_snapshot.commit', result: {
        import_id: id, stage_version: 3, committed: true, active_generation: 6,
      } },
    ]
    for (const frame of frames) {
      const source = wire(frame)
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
    }
    expectMutationsRejected(wire(frames[2]), ['result', 'state'], [null, 'verified'])
    const status = { ...frames[2], method: 'migration.import_snapshot.status' }
    expectMutationsRejected(wire(status), ['result', 'state'], [null, ['staged'], 'unknown'])
    expectMutationsRejected(wire(frames[3]), ['result', 'verified'], [false, 1, 'true'])
    expectMutationsRejected(wire(frames[4]), ['result', 'committed'], [false, 1, 'true'])
    const abort = { ...common, method: 'migration.import_snapshot.abort', result: {
      import_id: id, stage_version: 4, aborted: true,
    } }
    const abortSource = wire(abort)
    expect(encodeHostControlFrame(decodeHostControlFrame(abortSource))).toBe(abortSource)
    expectMutationsRejected(abortSource, ['result', 'aborted'], [false, 1, 'true'])
  })

  it('rejects a stage request that attempts to carry payload content', () => {
    const source = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"migration.import_snapshot.stage","params":{${auth},"transfer_id":"${'a'.repeat(48)}","transfer_digest":"${'b'.repeat(64)}","source_installation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","source_inventory_digest":"${'c'.repeat(64)}","source_generation":"${'d'.repeat(64)}","source_schema_version":0,"target_generation":5,"target_profile_selector":"${'A'.repeat(32)}.${'A'.repeat(86)}","record_count":3,"semantic_digest":"${'e'.repeat(64)}","payload":"secret"}}\n`
    expect(() => decodeHostControlFrame(source)).toThrow(HostControlProtocolError)
  })

  it('accepts the closed migration record vocabulary and rejects coercion or malformed linkage', () => {
    const frame = (records: readonly unknown[], final: unknown = true) => ({
      version: 1,
      type: 'result',
      request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140',
      method: 'migration.export_snapshot.read',
      result: {
        export_id: 'a'.repeat(48),
        chunk_index: 0,
        records,
        chunk_digest: 'd'.repeat(64),
        final,
      },
    })
    const base = { id: 'b'.repeat(32), sequence: 0, payload_digest: 'c'.repeat(64) }
    const records = [
      { collection: 'sessions', ...base },
      { collection: 'session_events', id: 'e'.repeat(32), session_id: 'b'.repeat(32), sequence: 1,
        payload_digest: 'f'.repeat(64) },
      ...(['owner_settings', 'owner_credentials', 'owner_workspace', 'owner_profile'] as const)
        .map(collection => ({ collection, ...base })),
    ]
    const source = wire(frame(records))
    expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
    expectMutationsRejected(source, ['result', 'export_id'], [null, 'a'.repeat(31), 'g'.repeat(48)])

    for (const record of [
      { collection: ['owner_settings'], ...base },
      { collection: 'unknown', ...base },
      { collection: 'sessions', ...base, id: 'not-an-id' },
      { collection: 'sessions', ...base, session_id: 'b'.repeat(32) },
      { collection: 'session_events', ...base },
      { collection: 'session_events', ...base, session_id: 'not-an-id' },
      { collection: 'owner_settings', ...base, sequence: -1 },
      { collection: 'owner_settings', ...base, payload_digest: 'not-a-digest' },
    ]) expect(() => decodeHostControlFrame(wire(frame([record])))).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame(wire(frame([], 'true')))).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame(wire(frame(Array.from({ length: 4097 }, () => ({}))))))
      .toThrow(HostControlProtocolError)
    for (const type of ['notification', null]) {
      expect(() => decodeHostControlFrame(wire({ ...frame([]), type }))).toThrow(HostControlProtocolError)
    }
    for (const type of ['request', 'result'] as const) {
      expect(() => decodeHostControlFrame(wire({
        version: 1,
        type,
        request_id: '018f0f4c-87f8-7e2d-a2f8-7b93d34e3140',
        method: 'migration.unknown',
        [type === 'request' ? 'params' : 'result']: {},
      }))).toThrow(expect.objectContaining({ code: 'unknown_method' }))
    }
  })
})
