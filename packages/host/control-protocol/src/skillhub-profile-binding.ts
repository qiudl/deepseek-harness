/** REQ-20261013-0021 / 24204. Independent SkillHub DSH Host/Profile signature domain. */

export const SKILLHUB_PROFILE_BINDING_DOMAIN = 'SLARK-SKILLHUB-DSH-PROFILE-BINDING/v1\0'

/** Exact Host-signed Slark actor, Computer, installation, Profile, and one-use challenge coordinates. */
export interface SkillHubProfileBindingPayload {
  readonly version: 1
  readonly actorUserId: string
  readonly computerId: string
  readonly installationId: string
  readonly profileId: string
  readonly bindingGeneration: string
  readonly challengeId: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const OPAQUE = /^[^\u0000-\u001f\u007f]{1,200}$/u

/**
 * Encode the exact field order consumed by Slark's independent verifier.
 * @param value - Current Host-local Profile and Slark challenge coordinates.
 * @returns Canonical UTF-8 JSON text without the signature domain prefix.
 */
export function encodeSkillHubProfileBindingPayload(value: SkillHubProfileBindingPayload): string {
  if (!OPAQUE.test(value.actorUserId) || value.actorUserId.trim() !== value.actorUserId
    || !OPAQUE.test(value.computerId) || value.computerId.trim() !== value.computerId
    || !UUID.test(value.installationId) || !UUID.test(value.profileId) || !UUID.test(value.challengeId)
    || !/^[1-9][0-9]{0,15}$/u.test(value.bindingGeneration)
    || !Number.isSafeInteger(Number(value.bindingGeneration))) throw new Error('invalid_skillhub_profile_binding')
  return JSON.stringify({
    version: value.version,
    actorUserId: value.actorUserId,
    computerId: value.computerId,
    installationId: value.installationId,
    profileId: value.profileId,
    bindingGeneration: value.bindingGeneration,
    challengeId: value.challengeId,
  })
}
