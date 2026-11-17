import { expect, it } from 'vitest'
import { parseHostBotAttachmentDownloadOpen, parseHostBotAttachmentDownloadChunk } from '../src/bot-attachment-download.ts'
import { parseHostBotCapabilities } from '../src/bot-capabilities.ts'
import { parseHostBotChannelMirrorMutationReceipt } from '../src/bot-channel-mirror-mutation.ts'
import { parseHostBotCreateReceipt } from '../src/bot-create.ts'
import { parseHostBotDuplicateReceipt } from '../src/bot-duplicate.ts'
import { parseHostBotFeedbackLogChunk } from '../src/bot-feedback-log.ts'
import { parseHostBotFeedback } from '../src/bot-feedback.ts'
import { parseHostBotFolders } from '../src/bot-folders.ts'
import { parseHostBotGeneralSettingsUpdateResult } from '../src/bot-general-settings.ts'
import { parseHostBotMemoryMutationReceipt } from '../src/bot-memory-mutation.ts'
import { parseHostBotMemory } from '../src/bot-memory.ts'
import { parseHostBotProviderDiscovery, parseHostBotProviders } from '../src/bot-providers.ts'
import { parseHostBotRoomHistory } from '../src/bot-room-history.ts'
import { parseHostBotRoomCreateReceipt, parseHostBotRoomDeleteReceipt } from '../src/bot-room-lifecycle.ts'
import { parseHostBotRoomReceipt } from '../src/bot-room-submission.ts'
import { parseHostBotRoomUpdateReceipt } from '../src/bot-room-update.ts'
import { parseHostBotScheduleHistory } from '../src/bot-schedule-history.ts'
import { parseHostBotScheduleMutationReceipt } from '../src/bot-schedule-mutation.ts'
import { parseHostBotSchedules } from '../src/bot-schedules.ts'
import { parseHostBotSecrets } from '../src/bot-secrets.ts'
import { parseHostBotSettingsUpdateReceipt } from '../src/bot-settings-update.ts'

// A null reply is an explicit unavailable result at each Bot read boundary.
// Keep this invariant across surfaces so an offline Host does not look like a
// malformed result or a successful empty collection.
const nullableReplies = [
  parseHostBotAttachmentDownloadOpen, parseHostBotAttachmentDownloadChunk,
  parseHostBotCapabilities, parseHostBotChannelMirrorMutationReceipt,
  parseHostBotCreateReceipt, parseHostBotDuplicateReceipt,
  parseHostBotFeedbackLogChunk, parseHostBotFeedback, parseHostBotFolders,
  parseHostBotGeneralSettingsUpdateResult, parseHostBotMemoryMutationReceipt,
  parseHostBotMemory, parseHostBotProviderDiscovery, parseHostBotProviders,
  parseHostBotRoomHistory, parseHostBotRoomCreateReceipt, parseHostBotRoomDeleteReceipt,
  parseHostBotRoomReceipt, parseHostBotRoomUpdateReceipt,
  parseHostBotScheduleHistory, parseHostBotScheduleMutationReceipt,
  parseHostBotSchedules, parseHostBotSecrets, parseHostBotSettingsUpdateReceipt,
]

it('preserves explicit unavailability across Bot remote replies', () => {
  for (const parse of nullableReplies) {
    expect(Reflect.apply(parse, undefined, [null, undefined]) as unknown, parse.name).toBeNull()
  }
})
