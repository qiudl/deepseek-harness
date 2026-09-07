import { HostAuthorityError } from './types.ts'
import type { MigrationExportService } from './unix-transport.ts'

/**
 * Resolves the active generation for every new operation while retaining the
 * exact snapshot service that owns an already-issued export id.
 */
export class CurrentMigrationExportService implements MigrationExportService {
  private readonly retained = new Map<string, MigrationExportService>()

  constructor(
    private readonly current: () => Promise<MigrationExportService>,
    private readonly quiesced: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {}

  inventory(signal?: AbortSignal): ReturnType<MigrationExportService['inventory']> {
    return this.quiesced(async () => (await this.current()).inventory(signal))
  }

  begin(
    request: Parameters<MigrationExportService['begin']>[0],
    signal?: AbortSignal,
  ): ReturnType<MigrationExportService['begin']> {
    return this.quiesced(async () => {
      const service = await this.current()
      const receipt = await service.begin(request, signal)
      this.retained.set(receipt.exportId, service)
      return receipt
    })
  }

  read(request: Parameters<MigrationExportService['read']>[0]): ReturnType<MigrationExportService['read']> {
    const service = this.retained.get(request.exportId)
    if (!service) throw new HostAuthorityError('stale')
    return service.read(request)
  }
}
