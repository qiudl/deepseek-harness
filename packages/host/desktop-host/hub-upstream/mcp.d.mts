/** Types for the unchanged upstream helpers used by the Host adapter. */
export interface McpServerSpec {
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}
export interface McpRow { id: string; name: string; config: Record<string, unknown> }
export function parseMcpJson(text: string): { servers: McpServerSpec[]; warnings: string[] }
export function convertToRows(servers: McpServerSpec[]): McpRow[]
export function extractMcpServers(text: string): McpRow[]
export function mergeMcpRows(text: string, rows: McpRow[]): string
export function deleteMcpRow(text: string, id: string): string
export function updateMcpRow(text: string, row: McpRow): string
