/** Closed, payload-free failures owned by the private Slark package/data upgrade. */
type ProfileUpgradeFailureCode =
  | 'bot_upgrade_backup_missing'
  | 'bot_upgrade_data_loss'
  | 'bot_upgrade_data_malformed'
  | 'bot_upgrade_data_too_large'
  | 'bot_upgrade_history_conversion_required'
  | 'bot_upgrade_reader_changed'
  | 'bot_upgrade_reader_incompatible'
  | 'bot_upgrade_reader_not_writable'
  | 'bot_upgrade_reader_shutdown_failed'
  | 'bot_upgrade_schema_unsupported'
  | 'bot_upgrade_session_conversion_required'
  | 'bot_upgrade_source_changed'
  | 'bot_upgrade_writer_not_quiescent'
  | 'invalid_bot_upgrade_backup'
  | 'invalid_bot_upgrade_operation'
  | 'invalid_bot_upgrade_policy'
  | 'invalid_patch'
  | 'invalid_profile_manifest'
  | 'invalid_profile_upgrade_backup'
  | 'invalid_profile_upgrade_copy'
  | 'invalid_profile_upgrade_journal'
  | 'profile_upgrade_backup_conflict'
  | 'profile_upgrade_backup_too_large'
  | 'profile_upgrade_conflicting_journals'
  | 'profile_upgrade_copy_changed'
  | 'profile_upgrade_copy_unverified'
  | 'profile_upgrade_custom_home'
  | 'profile_upgrade_custom_root'
  | 'profile_upgrade_existing_data_requires_recovery'
  | 'profile_upgrade_generation_changed'
  | 'profile_upgrade_generation_invalid'
  | 'profile_upgrade_not_found'
  | 'profile_upgrade_owner_changed'
  | 'profile_upgrade_pending'
  | 'profile_upgrade_phase'
  | 'profile_upgrade_policy_unavailable'
  | 'profile_upgrade_receipt_changed'
  | 'profile_upgrade_receipt_required'
  | 'profile_upgrade_rollback_blocked'
  | 'profile_upgrade_root_changed'
  | 'profile_upgrade_selection_changed'
  | 'profile_upgrade_source_changed'
  | 'profile_upgrade_source_unsupported'
  | 'profile_upgrade_stale'
  | 'unsafe_bot_upgrade_directory'
  | 'unsafe_bot_upgrade_source'
  | 'unsafe_profile_upgrade_journal'
  | 'unsafe_profile_upgrade_state'

/** Upgrade failure identity; callers retain original progress and never route recovery by message text. */
export class ProfileUpgradeFailure extends Error {
  /**
   * @param code Stable private diagnostic; no paths or user payloads.
   * @param options Original cause retained for the owning Host diagnostic handler.
   */
  constructor(readonly code: ProfileUpgradeFailureCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'ProfileUpgradeFailure'
  }
}
