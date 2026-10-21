/** Refuse direct user input to an original Session while its group fence is installed. */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'

/** Controller plugin that enforces the original Session's local user-input fence. */
export const GroupInputGate: Plugin.Object<void> = {
  name: 'group-input-gate',
  inject: ['workspaceRegistry'],
  apply(ctx: Context): void {
    ctx.on('agent/pre-inbox', ({ agent, message }) => {
      if (message.source.kind === 'user' && ctx.workspaceRegistry.isGroupInputBlocked(agent.id)) {
        throw new Error('group_session_active')
      }
    })
  },
}
