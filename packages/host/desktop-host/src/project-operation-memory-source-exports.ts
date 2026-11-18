import { ProjectOperationMemorySourceDelivery, projectMemorySourceRow as row, projectMemorySourceSame as same, assertProjectMemorySourceIdentity, projectMemorySourcePublicKey, projectMemorySourceEnvelope, projectMemorySourceOriginal, projectMemorySourceReceiptState } from './project-operation-memory-source-delivery.ts'

import type { ProjectMemorySourceOptions, ProjectMemorySourceRecord } from './project-operation-memory-source-delivery.ts'

/** Body-free source-export staging and finalization under the single Host writer. */


import type { HostProjectMemoryDirective, HostProjectMemoryStage, HostProjectMemoryHostAck, HostProjectMemoryReceipt } from '@deepseek-ai/dsh-host-control-protocol'

import { ProjectOperationMemoryDatabase } from './project-operation-memory-database.ts'

import type { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
import { projectOperationMemoryEventsDigest } from './project-operation-memory-metadata.ts'
import { HostAuthorityError } from './types.ts'

type Record = ProjectMemorySourceRecord
const fail = (): never => { throw new HostAuthorityError('unavailable') }
/** Durable original Ack and exact committed intervals; no exported event or material body is stored. */
export class ProjectOperationMemorySourceExports extends ProjectOperationMemorySourceDelivery<Record, ProjectOperationMemoryDatabase> {
  protected readonly key
  constructor(
    protected readonly options: ProjectMemorySourceOptions<ProjectOperationMemoryDatabase>,
  ) {
    super('private')
    assertProjectMemorySourceIdentity(options)
    this.key = projectMemorySourcePublicKey(options.publicKey)
  }
  protected invalidDisposition(r: HostProjectMemoryReceipt,
    d: HostProjectMemoryReceipt['dispositions'][number]): boolean {
    return (r.stage === 'delivery_committed' ? d.state !== 'reference_only' : d.state !== 'rejected') ||
      d.rightId !== null || d.rightGeneration !== null
  }
  protected parse(value: unknown): Record {
    const r = row(value, [
      'ownerUserId',
      'authorityEnvironmentId',
      'ack',
      'proof',
      'previousCheckpoint',
      'anchorCheckpoint',
      'eventsDigest',
      'revisionsDigest',
      'cloudReceipt',
      'activatedAt',
    ])
    const envelope = projectMemorySourceEnvelope(r, this.options, this.key)
    const original = projectMemorySourceOriginal(r, envelope)
    return { ...original, ...projectMemorySourceReceiptState(r, value => this.receipt(value, original)) }
  }
  /** Stage only a real signed page manifest and return its first durable Ack on every exact retry.
   * @param d - Current fixed-key verified source-export directive.
   * @param c - Closed original stage command.
   * @param metadata - Actual Host-owned published-page manifests.
   * @param now - Current Host clock.
   * @param sign - Installation-owned signer.
   * @param guard - Current Account/peer/deadline publication fence.
   * @returns First original durable body-free Ack.
   */
  stage(
    d: HostProjectMemoryDirective,
    c: HostProjectMemoryStage,
    metadata: ProjectOperationMemoryMetadata,
    now: number,
    sign: (payload: Buffer) => string,
    guard: () => void,
  ): HostProjectMemoryHostAck {
    if (metadata.database !== this.options.database) return fail()
    return this.options.database.transaction(guard, () => {
      const prior = this.stagedAck(d, c)
      if (prior) return prior
      const manifest = metadata.publishedRead(c.sourceProofDigest),
        original = metadata.find(d.scope, d.ownerUserId, d.authorityEnvironmentId)
      if (
        c.participantRole !== 'source_export' ||
        !d.peer ||
        !manifest ||
        !original ||
        !same(manifest.proof, c.sourceProof) ||
        c.sourceProof.issuedAt > now ||
        c.sourceProof.expiresAt <= now ||
        !same(manifest.checkpoint, c.expectedCheckpoint) ||
        manifest.eventsDigest !== projectOperationMemoryEventsDigest(c.events) ||
        c.events.some(e => e.sourcePolicy !== 'live_reference_v1' || e.materialDependencies.length !== 0)
      )
        return fail()
      const anchorCheckpoint = this.stageCheckpoint(d, original.anchor, manifest.proof, guard, sign)
      const ack = this.sourceAck(d, c, now, guard, sign)
      this.retainStage(d, c, manifest, anchorCheckpoint, ack, guard)
      metadata.stagedRead(c.sourceProofDigest, guard)
      return ack
    })
  }
}
