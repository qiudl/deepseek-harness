import { win32 } from 'node:path'
import type { HostJournal, JournalEvent } from './session-command.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const SHA256 = /^[0-9a-f]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true })

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort()
  const sorted = [...expected].sort()
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index])
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && !CONTROL_CHARACTER.test(value)
}

function journalEvent(value: unknown): JournalEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HostAuthorityError('unavailable')
  const record = value as Record<string, unknown>
  const committed = record.kind === 'command_committed'
  if (!['command_started', 'command_committed', 'command_failed'].includes(String(record.kind))
    || !exactKeys(record, [
      'kind', 'profileId', 'sessionId', 'commandId', 'payloadHash', ...(committed ? ['outcome'] : []), 'at',
    ])
    || !boundedText(record.profileId) || !boundedText(record.sessionId) || !boundedText(record.commandId)
    || typeof record.payloadHash !== 'string' || !SHA256.test(record.payloadHash)
    || !Number.isSafeInteger(record.at) || (record.at as number) < 0) {
    throw new HostAuthorityError('unavailable')
  }
  return record as unknown as JournalEvent
}

/** Atomic Windows command journal owned by the already-held single Host lease. */
export class WindowsHostJournal implements HostJournal {
  private readonly path: string
  private readonly securityDescriptor: string

  constructor(private readonly options: {
    readonly root: string
    readonly userSid: string
    readonly maximumJournalBytes: number
    readonly bindings: WindowsHostRegistrationFileBindings
  }) {
    if (!DRIVE_ROOTED_PATH.test(options.root) || CONTROL_CHARACTER.test(options.root)
      || options.root.slice(2).includes(':') || win32.normalize(options.root) !== options.root
      || !Number.isSafeInteger(options.maximumJournalBytes) || options.maximumJournalBytes < 1) {
      throw new HostAuthorityError('invalid_input')
    }
    this.path = win32.join(options.root, 'commands.jsonl')
    this.securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
    this.ensureRoot()
  }

  append(event: JournalEvent): void {
    journalEvent(event)
    let encoded: Buffer
    try {
      const line = JSON.stringify(event)
      journalEvent(JSON.parse(line) as unknown)
      encoded = Buffer.from(`${line}\n`)
    } catch { throw new HostAuthorityError('invalid_input') }
    const existing = this.readSource()
    if (encoded.length > this.options.maximumJournalBytes - existing.length) {
      throw new HostAuthorityError('unavailable')
    }
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.replacePrivateFile(
        this.path,
        Buffer.concat([existing, encoded]),
        this.securityDescriptor,
      ),
      'file',
      this.options.userSid,
    )
  }

  read(): readonly JournalEvent[] {
    const source = this.readSource()
    if (source.length === 0) return []
    let text: string
    try { text = UTF8.decode(source) } catch { throw new HostAuthorityError('unavailable') }
    if (!text.endsWith('\n')) throw new HostAuthorityError('unavailable')
    try { return text.slice(0, -1).split('\n').map(line => journalEvent(JSON.parse(line) as unknown)) } catch {
      throw new HostAuthorityError('unavailable')
    }
  }

  private ensureRoot(): void {
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.ensurePrivateDirectory(this.options.root, this.securityDescriptor),
      'directory',
      this.options.userSid,
    )
  }

  private readSource(): Buffer {
    this.ensureRoot()
    const file = this.options.bindings.readPrivateFile(this.path, this.options.maximumJournalBytes)
    if (file === undefined) return Buffer.alloc(0)
    assertWindowsHostPrivatePathEvidence(file.evidence, 'file', this.options.userSid)
    if (file.contents.length > this.options.maximumJournalBytes) throw new HostAuthorityError('unavailable')
    return file.contents
  }
}
