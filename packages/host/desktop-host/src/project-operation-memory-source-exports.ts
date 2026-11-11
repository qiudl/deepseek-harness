/** Body-free source-export staging and finalization under the single Host writer. */
import type {
  HostProjectMemoryDirective,
  HostProjectMemoryStage,
  HostProjectMemoryHostAck,
  HostProjectMemoryReceipt,
  HostProjectMemoryEnvironment,
} from '@deepseek-ai/dsh-host-control-protocol'
import type { ProjectOperationMemoryDatabase } from './project-operation-memory-database.ts'
import { projectMemoryRecordBytes } from './project-operation-memory-database.ts'
import type { ProjectOperationMemoryMetadata } from './project-operation-memory-metadata.ts'
import { projectOperationMemoryEventsDigest } from './project-operation-memory-metadata.ts'
import { ProjectOperationMemorySourceDeliveries } from './project-operation-memory-source-deliveries.ts'
import type { ProjectMemorySourceRecord } from './project-operation-memory-source-deliveries.ts'
import { fail, same } from './project-operation-memory-source-rows.ts'

type Options = Readonly<{
  profileId: string
  installationId: string
  publicKey: string
  database: ProjectOperationMemoryDatabase
  environments: readonly HostProjectMemoryEnvironment[]
}>
/** Durable original Ack and exact committed intervals; no exported event or material body is stored. */
export class ProjectOperationMemorySourceExports extends ProjectOperationMemorySourceDeliveries<
  ProjectMemorySourceRecord,
  Options
> {
  constructor(options: Options) {
    super(options, {
      deliveryDomain: 'dsh.project-operation-memory-private-delivery/v1\0',
      frontierDomain: 'dsh.project-operation-memory-private-frontier/v1\0',
      extraFields: [],
      recordBytes: projectMemoryRecordBytes,
    })
  }
  protected invalidDispositions(r: HostProjectMemoryReceipt): boolean {
    return r.dispositions.some(
      d =>
        (r.stage === 'delivery_committed' ? d.state !== 'reference_only' : d.state !== 'rejected') ||
        d.rightId !== null ||
        d.rightGeneration !== null,
    )
  }
  protected parseExtra(): Record<never, never> {
    return {}
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
    return this.stageDelivery(
      d,
      c,
      now,
      sign,
      guard,
      () => {
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
        return { manifest, original, extra: {} }
      },
      () => {
        metadata.stagedRead(c.sourceProofDigest, guard)
      },
    )
  }
}
