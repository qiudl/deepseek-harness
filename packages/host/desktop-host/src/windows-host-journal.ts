import { win32 } from 'node:path'
import { parseCommandJournalEvent } from './command-journal-event.ts'
import type { HostJournal, JournalEvent } from './session-command.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'
import { HostAuthorityError } from './types.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_ROOTED_PATH = /^[A-Za-z]:\\/u
const UTF8 = new TextDecoder('utf-8', { fatal: true })

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
    parseCommandJournalEvent(event)
    let encoded: Buffer
    try {
      const line = JSON.stringify(event)
      parseCommandJournalEvent(JSON.parse(line) as unknown)
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
    try { return text.slice(0, -1).split('\n').map(line => parseCommandJournalEvent(JSON.parse(line) as unknown)) } catch {
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
