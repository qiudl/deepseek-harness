/**
 * Fake in-memory Win32 security world for the Windows Host registration native
 * specs. The release evidence decoder reads the descriptor's binary form
 * (control word, ACL header, inline ACE trustee SIDs) through Koffi address
 * decoding, so these specs model that addressable memory instead of SDDL text:
 * every allocation lands in a flat address space the mock Koffi decode reads,
 * and the security functions back their output pointers with encoded SID and
 * ACL bytes. A SID string always round-trips to the same bytes, so trustee
 * comparisons exercise the canonical-SID path without an SDDL alias layer.
 */

export interface FakeAceSpec {
  /** ACCESS_ALLOWED_ACE_TYPE (0), ACCESS_DENIED_ACE_TYPE (1), or a raw type byte. */
  readonly type: number
  /** ACE_HEADER AceFlags byte (OI 0x01, CI 0x02, INHERITED 0x10). */
  readonly flags: number
  /** ACCESS_MASK; private admission requires the exact full-control mask. */
  readonly mask: number
  /** Canonical SID string; encoded inline after the 8-byte ACE header. */
  readonly sid: string
  /** Corrupt the AceSize header field (defaults to the encoded size). */
  readonly aceSize?: number
}

export interface FakeSecurityEvidence {
  /** Owner SID, or null to make GetSecurityInfo report no owner. */
  readonly ownerSid: string | null
  /** SE_DACL_PROTECTED flag read through GetSecurityDescriptorControl. */
  readonly daclProtected: boolean
  /** ACEs in DACL order; an empty list with daclPresent keeps a present empty DACL. */
  readonly aces: readonly FakeAceSpec[]
  /** Present a null DACL pointer (the descriptor carries no DACL). */
  readonly noDacl?: boolean
  /** Corrupt the AclSize header field (defaults to the encoded size). */
  readonly aclSize?: number
}

export interface FakeSecurityWorld {
  /** Allocate one addressable native block. */
  readonly alloc: (bytes: Buffer) => bigint
  /** Read one unsigned field inside any allocated block (addresses may point into a block). */
  readonly read: (address: bigint, offset: number, type: 'uint8' | 'uint16' | 'uint32') => number
  /** Read one NUL-terminated UTF-16 string at an allocated address. */
  readonly readText: (address: bigint) => string
  /** Allocate one NUL-terminated UTF-16 string and return its address. */
  readonly writeText: (text: string) => bigint
  /** Encode one canonical SID string into its binary form. */
  readonly sidBytes: (sid: string) => Buffer
  /** Native function implementations for GetSecurityInfo, GetSecurityDescriptorControl, GetAce, and ConvertSidToStringSidW. */
  readonly functions: Record<string, (...args: unknown[]) => unknown>
  /** Mock Koffi decode handling (slot, 'str16') and (address, offset, uint8|uint16|uint32) reads. */
  readonly decode: (value: unknown, offsetOrType?: unknown, maybeType?: unknown) => unknown
  /** Point the security functions at freshly encoded evidence. */
  setEvidence: (evidence: FakeSecurityEvidence) => void
}

const SE_DACL_PROTECTED = 0x1000
const ACL_REVISION = 2
const SID_REVISION = 1
const MAX_SID_SUB_AUTHORITIES = 15

/**
 * Build one flat-address-space security world. Allocations are never freed;
 * the specs load one world per case, so growth is bounded by the case count.
 * @returns the fake security world.
 */
export function createFakeSecurityWorld(): FakeSecurityWorld {
  const blocks: Array<{ readonly address: bigint; readonly bytes: Buffer }> = []
  let nextAddress = 0x10_000n

  const alloc = (bytes: Buffer): bigint => {
    const address = nextAddress
    nextAddress += BigInt(bytes.length + 8)
    const copy = Buffer.from(bytes)
    blocks.push({ address, bytes: copy })
    return address
  }

  const locate = (address: bigint, offset: number, size: number): { readonly block: Buffer; readonly at: number } => {
    for (const { address: base, bytes } of blocks) {
      const delta = address - base
      if (delta >= 0n && Number(delta) + offset + size <= bytes.length) {
        return { block: bytes, at: Number(delta) + offset }
      }
    }
    throw new Error(`unallocated native address ${String(address)}+${String(offset)}`)
  }

  const read = (address: bigint, offset: number, type: 'uint8' | 'uint16' | 'uint32'): number => {
    const size = type === 'uint8' ? 1 : type === 'uint16' ? 2 : 4
    const { block, at } = locate(address, offset, size)
    if (type === 'uint8') return block.readUInt8(at)
    if (type === 'uint16') return block.readUInt16LE(at)
    return block.readUInt32LE(at)
  }

  const readText = (address: bigint): string => {
    let text = ''
    for (let offset = 0; offset < 4096; offset += 2) {
      const unit = read(address, offset, 'uint16')
      if (unit === 0) return text
      text += String.fromCharCode(unit)
    }
    throw new Error(`unterminated native string at ${String(address)}`)
  }

  const writeText = (text: string): bigint => alloc(Buffer.from(`${text}\0`, 'utf16le'))

  const sidBytes = (sid: string): Buffer => {
    const match = /^S-([0-9]+)-([0-9]+)((?:-[0-9]+)+)$/u.exec(sid)
    if (match === null || match[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw new Error(`not a canonical SID string: ${sid}`)
    }
    const subauthorities = match[3].slice(1).split('-').map((value) => {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xFFFF_FFFF) throw new Error(`subauthority out of range: ${value}`)
      return parsed
    })
    if (subauthorities.length === 0 || subauthorities.length > MAX_SID_SUB_AUTHORITIES) {
      throw new Error(`implausible subauthority count in ${sid}`)
    }
    const authority = BigInt(match[2])
    if (authority < 0n || authority > 0xFFFF_FFFF_FFFFn) throw new Error(`authority out of range in ${sid}`)
    const bytes = Buffer.alloc(8 + subauthorities.length * 4)
    bytes.writeUInt8(SID_REVISION, 0)
    bytes.writeUInt8(subauthorities.length, 1)
    for (let index = 0; index < 6; index += 1) {
      bytes.writeUInt8(Number((authority >> BigInt(8 * (5 - index))) & 0xFFn), 2 + index)
    }
    subauthorities.forEach((subauthority, index) => bytes.writeUInt32LE(subauthority, 8 + index * 4))
    return bytes
  }

  const aceBytes = (ace: FakeAceSpec): Buffer => {
    const sid = sidBytes(ace.sid)
    const size = 8 + sid.length
    const bytes = Buffer.alloc(size)
    bytes.writeUInt8(ace.type, 0)
    bytes.writeUInt8(ace.flags, 1)
    bytes.writeUInt16LE(ace.aceSize ?? size, 2)
    bytes.writeUInt32LE(ace.mask >>> 0, 4)
    sid.copy(bytes, 8)
    return bytes
  }

  const aclBytes = (aces: readonly FakeAceSpec[], aclSize?: number): Buffer => {
    const body = Buffer.concat(aces.map(aceBytes))
    const bytes = Buffer.alloc(8 + body.length)
    bytes.writeUInt8(ACL_REVISION, 0)
    bytes.writeUInt16LE(aclSize ?? bytes.length, 2)
    bytes.writeUInt16LE(aces.length, 4)
    body.copy(bytes, 8)
    return bytes
  }

  let ownerAddress: bigint | null = null
  let daclAddress: bigint | null = null
  let control = 0

  const world: FakeSecurityWorld = {
    alloc,
    read,
    readText,
    writeText,
    sidBytes,
    decode: (value: unknown, offsetOrType?: unknown, maybeType?: unknown): unknown => {
      if (typeof value === 'bigint') {
        return read(value, Number(offsetOrType), maybeType as 'uint8' | 'uint16' | 'uint32')
      }
      if (Buffer.isBuffer(value) && offsetOrType === 'str16') return readText(value.readBigUInt64LE(0))
      return value
    },
    functions: {
      GetSecurityInfo: (_handle, _type, _info, owner, _group, dacl, _sacl, descriptor) => {
        if (!Buffer.isBuffer(owner) || !Buffer.isBuffer(dacl) || !Buffer.isBuffer(descriptor)) {
          throw new Error('expected security information buffers')
        }
        owner.writeBigUInt64LE(ownerAddress ?? 0n)
        dacl.writeBigUInt64LE(daclAddress ?? 0n)
        descriptor.writeBigUInt64LE(alloc(Buffer.alloc(8)))
        return 0
      },
      GetSecurityDescriptorControl: (_descriptor, controlSlot, _revisionSlot) => {
        if (!Buffer.isBuffer(controlSlot)) throw new Error('expected control buffer')
        controlSlot.writeUInt16LE(control, 0)
        return 1
      },
      GetAce: (dacl, index, ace) => {
        if (typeof dacl !== 'bigint' || !Buffer.isBuffer(ace)) throw new Error('expected ACL pointer and ACE slot')
        let offset = 8 // the first ACE follows the 8-byte ACL header
        for (let walk = 0; walk < Number(index); walk += 1) offset += read(dacl, offset + 2, 'uint16')
        ace.writeBigUInt64LE(dacl + BigInt(offset))
        return 1
      },
      ConvertSidToStringSidW: (sid, output) => {
        if (typeof sid !== 'bigint' || !Buffer.isBuffer(output)) throw new Error('expected SID pointer and output slot')
        const revision = read(sid, 0, 'uint8')
        const count = read(sid, 1, 'uint8')
        if (revision !== SID_REVISION || count > MAX_SID_SUB_AUTHORITIES) return 0
        let authority = 0n
        for (let index = 0; index < 6; index += 1) authority = (authority << 8n) | BigInt(read(sid, 2 + index, 'uint8'))
        const parts = [`S-${String(revision)}-${String(authority)}`]
        for (let index = 0; index < count; index += 1) parts.push(String(read(sid, 8 + index * 4, 'uint32')))
        output.writeBigUInt64LE(writeText(parts.join('-')))
        return 1
      },
    },
    setEvidence: (evidence: FakeSecurityEvidence): void => {
      ownerAddress = evidence.ownerSid === null ? null : alloc(sidBytes(evidence.ownerSid))
      daclAddress = evidence.noDacl === true ? null : alloc(aclBytes(evidence.aces, evidence.aclSize))
      control = evidence.daclProtected ? SE_DACL_PROTECTED : 0
    },
  }
  return world
}
