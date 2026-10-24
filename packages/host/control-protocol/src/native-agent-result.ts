/** REQ-20261023-0013: one signed Slark Agent chunk sent through the Host control channel. */
import { parseHostNativeRoomCommand, type HostNativeRoomCommand } from './native-room-operations.ts'

type ChunkCommand = Extract<HostNativeRoomCommand, { operation: 'agent-result-chunk' }>
/** The exact Account-bound Host input for one signed native Agent result chunk. */
export interface HostNativeAgentResultInput {
  readonly computer_id: string
  readonly slark_audience: string
  readonly workspace_id: string
  readonly session_id: string
  readonly ticket: string
  readonly command: ChunkCommand
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const coordinate = (value: unknown): value is string => typeof value === 'string' &&
  /^[\x21-\x7e]{1,256}$/u.test(value) && !/[/\\]/u.test(value) &&
  value !== '.' && value !== '..'
/**
 * Check all coordinates and reject extra fields before the Host verifies the ticket.
 * @param value - untrusted control-frame parameters.
 * @returns the exact native Agent result input.
 */
export function parseHostNativeAgentResultInput(value: unknown): HostNativeAgentResultInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw Error('native_agent_result_invalid')
  const row = value as Record<string, unknown>
  const keys = ['computer_id', 'slark_audience', 'workspace_id', 'session_id',
    'ticket', 'command']
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) ||
      !coordinate(row.computer_id) || typeof row.slark_audience !== 'string' ||
      typeof row.workspace_id !== 'string' || !UUID.test(row.workspace_id) ||
      !coordinate(row.session_id) || typeof row.ticket !== 'string' ||
      Buffer.byteLength(row.ticket, 'utf8') > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(row.ticket))
    throw Error('native_agent_result_invalid')
  try {
    const url = new URL(row.slark_audience)
    if (url.protocol !== 'https:' || url.origin !== row.slark_audience)
      throw Error('native_agent_result_invalid')
  } catch { throw Error('native_agent_result_invalid') }
  let command: HostNativeRoomCommand
  try { command = parseHostNativeRoomCommand(row.command) }
  catch { throw Error('native_agent_result_invalid') }
  if (command.operation !== 'agent-result-chunk') throw Error('native_agent_result_invalid')
  return { computer_id: row.computer_id, slark_audience: row.slark_audience,
    workspace_id: row.workspace_id, session_id: row.session_id,
    ticket: row.ticket, command }
}
