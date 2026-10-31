import { win32 } from 'node:path'
import { validateExtensionReceipt, type ExtensionReceipt, type ExtensionReceiptStore } from './extension-operations.ts'
import {
  assertWindowsHostPrivatePathEvidence,
  windowsHostPrivateSecurityDescriptor,
  type WindowsHostRegistrationFileBindings,
} from './windows-host-registration.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true })
function id(value: string): void { if (!UUID.test(value)) throw Error('invalid_input') }

/** Atomic, SID-owned Windows receipt collection; the caller holds the single Host lease throughout use. */
export class WindowsExtensionReceipts implements ExtensionReceiptStore {
  private readonly path: string
  private readonly securityDescriptor: string
  constructor(private readonly options: {
    readonly root: string
    readonly userSid: string
    readonly maximumBytes: number
    readonly bindings: WindowsHostRegistrationFileBindings
  }) {
    if (!/^[A-Za-z]:\\/u.test(options.root) || /[\u0000-\u001f\u007f]/u.test(options.root)
      || options.root.slice(2).includes(':') || win32.normalize(options.root) !== options.root
      || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1) throw Error('invalid_input')
    this.path = win32.join(options.root, 'extensions.v1.json')
    this.securityDescriptor = windowsHostPrivateSecurityDescriptor(options.userSid)
    this.directory()
  }
  private directory(): void {
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.ensurePrivateDirectory(this.options.root, this.securityDescriptor), 'directory', this.options.userSid,
    )
  }
  private decode(bytes: Buffer): ExtensionReceipt[] {
    if (bytes.length > this.options.maximumBytes) throw Error('unsafe_receipts')
    const value: unknown = JSON.parse(UTF8.decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_receipts')
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 2 || record.version !== 1 || !Array.isArray(record.receipts)) throw Error('invalid_receipts')
    const seen = new Set<string>()
    for (const receipt of record.receipts) {
      validateExtensionReceipt(receipt)
      if (Buffer.byteLength(JSON.stringify(receipt)) > 65_536 || seen.has(receipt.operationId)) throw Error('invalid_receipt')
      seen.add(receipt.operationId)
    }
    return record.receipts as ExtensionReceipt[]
  }
  private all(): ExtensionReceipt[] {
    this.directory()
    const file = this.options.bindings.readPrivateFile(this.path, this.options.maximumBytes)
    if (file === undefined) return []
    assertWindowsHostPrivatePathEvidence(file.evidence, 'file', this.options.userSid)
    return this.decode(file.contents)
  }
  /** @param operationId Opaque UUID. @returns Persisted receipt, or undefined only when absent. */
  read(operationId: string): ExtensionReceipt | undefined {
    id(operationId)
    return this.all().find(receipt => receipt.operationId === operationId)
  }
  /** @param profileId Authorized Profile UUID. @returns Only that Profile's persisted operations. */
  list(profileId: string): ExtensionReceipt[] {
    id(profileId)
    return this.all().filter(receipt => receipt.profileId === profileId)
  }
  /** @param receipt Metadata to publish without discarding other Profiles or interrupted operations. */
  write(receipt: ExtensionReceipt): void {
    validateExtensionReceipt(receipt)
    const all = this.all()
    const index = all.findIndex(item => item.operationId === receipt.operationId)
    if (index < 0) all.push(receipt)
    else all[index] = receipt
    const bytes = Buffer.from(JSON.stringify({ version: 1, receipts: all }))
    this.decode(bytes)
    assertWindowsHostPrivatePathEvidence(
      this.options.bindings.replacePrivateFile(this.path, bytes, this.securityDescriptor), 'file', this.options.userSid,
    )
  }
}
