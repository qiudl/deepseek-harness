/** REQ-20261022-0022: prepare a catalog-backed plugin layer under an existing import fence. */
import { installStagedProfileImportPluginsInIsolation } from './profile-import-plugin-isolated-install.ts'
import { planSelectedProfileImportPlugins } from './profile-import-plugin-plan.ts'
import { stageSelectedProfileImportPluginArchives } from './profile-import-plugin-stage.ts'
import { planProfileImportPluginTargetManifest } from './profile-import-plugin-target-manifest.ts'
import { resolveProfileImportTargetPluginsInIsolation,
  type ProfileImportTargetResolutionEvidence } from './profile-import-plugin-target-resolution.ts'
import { installResolvedProfileImportTargetPlugins } from './profile-import-plugin-target-install.ts'
import { planProfileImportPluginPublish,
  inspectStagedProfileImportPluginPublishCandidate,
  stageProfileImportPluginPublishCandidate } from './profile-import-plugin-publish-plan.ts'
import type { FileProfileImportPluginPublishJournal } from './profile-import-plugin-publish-journal.ts'

type Input = Omit<ProfileImportTargetResolutionEvidence, 'plan' | 'manifestPlan'> & Readonly<{
  expectedPreviewDigest: string
  selectedPluginNames: readonly string[]
  nodeExecutablePath: string
  pnpmEntrypointPath: string
  installAnchor: string
  publishJournal: FileProfileImportPluginPublishJournal
}>

type InspectionInput = Omit<Input, 'nodeExecutablePath' | 'pnpmEntrypointPath'>

/** Build and verify the complete inactive replacement before recording publish intent. */
export async function prepareSelectedProfileImportPlugins(input: Input): Promise<void> {
  const plan = await planSelectedProfileImportPlugins(input)
  await stageSelectedProfileImportPluginArchives({ ...input, plan })
  await installStagedProfileImportPluginsInIsolation({ ...input, plan,
    sourceProfileId: input.source.profileId })
  const manifestPlan = await planProfileImportPluginTargetManifest({ ...input, plan })
  const resolution = { ...input, plan, manifestPlan }
  await resolveProfileImportTargetPluginsInIsolation(resolution)
  await installResolvedProfileImportTargetPlugins(resolution)
  const publishInput = { ...resolution, installAnchor: input.installAnchor }
  const publishPlan = await planProfileImportPluginPublish(publishInput)
  await stageProfileImportPluginPublishCandidate(publishInput, publishPlan)
  await input.publishJournal.create({ operationId: input.operationId,
    sourceProfileId: input.source.profileId, targetProfileId: input.target.profileId,
    selectedPluginNames: input.selectedPluginNames, plan: publishPlan })
}

/** Rebuild every read-only proof before an old-web publication or retry. */
export async function inspectPreparedProfileImportPlugins(input: InspectionInput): Promise<void> {
  const record = await input.publishJournal.load(input.operationId)
  if (!record || !['prepared', 'switching'].includes(record.phase)
    || record.sourceProfileId !== input.source.profileId
    || record.targetProfileId !== input.target.profileId
    || JSON.stringify(record.selectedPluginNames) !== JSON.stringify(input.selectedPluginNames)) {
    throw Error('profile_import_plugin_publish_changed')
  }
  const plan = await planSelectedProfileImportPlugins(input)
  const manifestPlan = await planProfileImportPluginTargetManifest({ ...input, plan })
  const publishInput = { ...input, plan, manifestPlan, installAnchor: input.installAnchor }
  const publishPlan = await planProfileImportPluginPublish(publishInput)
  if (JSON.stringify(publishPlan) !== JSON.stringify(record.plan)
    || !(await inspectStagedProfileImportPluginPublishCandidate(publishInput, publishPlan))) {
    throw Error('profile_import_plugin_publish_changed')
  }
}
