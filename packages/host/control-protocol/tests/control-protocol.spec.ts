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
  migrationSemanticDigest,
} from '../src/index.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')

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
  })

  it('rejects oversized frames before JSON parsing', () => {
    const oversized = `${' '.repeat(HOST_CONTROL_MAX_FRAME_BYTES)}\n`
    expect(() => decodeHostControlFrame(oversized)).toThrow(HostControlProtocolError)
  })

  it('validates outbound values even when a caller bypasses static types', () => {
    const frame = decodeHostControlFrame(fixture('unsupported-protocol.error.jsonl'))
    const forged = { ...frame, leaked_detail: 'local filesystem contents' }
    expect(() => encodeHostControlFrame(forged as typeof frame)).toThrow(HostControlProtocolError)
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
})

describe('Main-only Profile operations', () => {
  const auth = '"client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3111","host_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3120","process_nonce":"_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q","jti":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3130","issued_at":1000,"expires_at":2000'

  it('round-trips Profile status, open, activation, and lease close without secret fields', () => {
    const status = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.status","params":{${auth},"authority_environment_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3181","account_binding_handle":"keychain-binding:opaque","authority_binding_version":1}}\n`
    const open = '{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"profile.open","result":{"profile_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","view_activation_handle":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","lease_generation":2,"expires_at":2000,"runtime_generation":5}}\n'
    const activate = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"profile.view_activate","params":{${auth},"profile_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","view_activation_handle":"ABEiM0RVZneImaq7zN3u_wARIjNEVWZ3iJmqu8zd7v8","lease_generation":2,"runtime_generation":5}}\n`
    const activated = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"profile.view_activate","result":{"origin":"http://127.0.0.1:4123","activation_generation":7,"expires_at":2000,"bootstrap_cookie":{"name":"dsh-auth-${'a'.repeat(43)}","value":"v1.${'b'.repeat(8)}.${'c'.repeat(43)}"}}}\n`
    const close = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"profile.lease_close","params":{${auth},"view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","lease_generation":2,"runtime_generation":5}}\n`
    for (const source of [status, open, activate, activated, close]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
      expect(source).not.toMatch(/"(?:token|cookie|path|subject)"/)
    }
  })

  it('rejects reordered auth fields and lease results carrying a URL', () => {
    const reordered = '{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"profile.status","params":{"host_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3120","client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3111","process_nonce":"_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q","jti":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3130","issued_at":1000,"expires_at":2000,"account_binding_handle":"binding"}}\n'
    const leaked = '{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"profile.open","result":{"profile_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","view_lease_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3151","lease_generation":2,"expires_at":2000,"runtime_generation":5,"url":"http://127.0.0.1"}}\n'
    expect(() => decodeHostControlFrame(reordered)).toThrow(HostControlProtocolError)
    expect(() => decodeHostControlFrame(leaked)).toThrow(HostControlProtocolError)
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
})

describe('owner-only migration import lifecycle', () => {
  const auth = '"client_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3111","host_instance_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3120","process_nonce":"_u3c-6mHZESVQ7tRzWjGo8nX5ApYxKfaJfwO06g6O1Q","jti":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3130","issued_at":1000,"expires_at":2000'

  it('requires the signed source Profile selector on export begin and read', () => {
    const selector = `${'A'.repeat(32)}.${'A'.repeat(86)}`
    const begin = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"migration.export_snapshot.begin","params":{${auth},"source_profile_selector":"${selector}","expected_inventory_digest":"${'c'.repeat(64)}","max_records":3,"max_bytes":4096}}\n`
    const inventory = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"migration.export_snapshot.inventory","params":{${auth},"source_profile_selector":"${selector}"}}\n`
    const read = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"migration.export_snapshot.read","params":{${auth},"source_profile_selector":"${selector}","export_id":"${'d'.repeat(48)}","chunk_index":0}}\n`
    for (const source of [inventory, begin, read]) expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
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
  })

  it('round-trips stage, verify, commit, and abort without payloads or paths', () => {
    const selector = `${'A'.repeat(32)}.${'A'.repeat(86)}`
    const stage = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"migration.import_snapshot.stage","params":{${auth},"transfer_id":"${'a'.repeat(48)}","transfer_digest":"${'b'.repeat(64)}","source_installation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","source_inventory_digest":"${'c'.repeat(64)}","source_generation":"${'d'.repeat(64)}","source_schema_version":0,"target_generation":5,"target_profile_selector":"${selector}","record_count":3,"semantic_digest":"${'e'.repeat(64)}"}}\n`
    const statusRequest = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3145","method":"migration.import_snapshot.status","params":{${auth},"transfer_id":"${'a'.repeat(48)}","target_generation":5,"source_installation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","target_profile_selector":"${selector}"}}\n`
    const status = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3144","method":"migration.import_snapshot.status","result":{"import_id":"${'f'.repeat(48)}","stage_version":2,"state":"staged","target_generation":5,"record_count":3,"semantic_digest":"${'e'.repeat(64)}"}}\n`
    const verify = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3141","method":"migration.import_snapshot.verify","params":{${auth},"import_id":"${'f'.repeat(48)}","expected_stage_version":1,"target_profile_selector":"${selector}"}}\n`
    const commit = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3142","method":"migration.import_snapshot.commit","params":{${auth},"import_id":"${'f'.repeat(48)}","expected_stage_version":2,"expected_current_generation":4,"target_profile_selector":"${selector}"}}\n`
    const abort = `{"version":1,"type":"result","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3143","method":"migration.import_snapshot.abort","result":{"import_id":"${'f'.repeat(48)}","stage_version":2,"aborted":true}}\n`
    for (const source of [stage, statusRequest, status, verify, commit, abort]) {
      expect(encodeHostControlFrame(decodeHostControlFrame(source))).toBe(source)
      expect(source).not.toMatch(/"(?:payload|path|url|token|cookie)"/u)
    }
  })

  it('rejects a stage request that attempts to carry payload content', () => {
    const source = `{"version":1,"type":"request","request_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3140","method":"migration.import_snapshot.stage","params":{${auth},"transfer_id":"${'a'.repeat(48)}","transfer_digest":"${'b'.repeat(64)}","source_installation_id":"018f0f4c-87f8-7e2d-a2f8-7b93d34e3150","source_inventory_digest":"${'c'.repeat(64)}","source_generation":"${'d'.repeat(64)}","source_schema_version":0,"target_generation":5,"target_profile_selector":"${'A'.repeat(32)}.${'A'.repeat(86)}","record_count":3,"semantic_digest":"${'e'.repeat(64)}","payload":"secret"}}\n`
    expect(() => decodeHostControlFrame(source)).toThrow(HostControlProtocolError)
  })
})
