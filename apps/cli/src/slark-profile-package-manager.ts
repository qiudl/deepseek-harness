/** Package-manager invocation supplied only to a Slark-owned Web Profile worker. */
import { delimiter, dirname, isAbsolute } from 'node:path'
import type { ProfilePnpmInvocation } from '@deepseek-ai/dsh-app-boot'

export function slarkProfilePackageManager(
  profile: string,
  environment: NodeJS.ProcessEnv,
  nodeExecutable: string,
  userHome: string,
): ProfilePnpmInvocation | undefined {
  if (profile !== 'web' || environment.DSH_SLARK_EMBEDDED !== '1') return undefined
  const pnpmEntrypoint = environment.DSH_PROFILE_PNPM_ENTRYPOINT
  if (pnpmEntrypoint === undefined) return undefined
  if (!isAbsolute(pnpmEntrypoint) || !isAbsolute(nodeExecutable)
    || /[\x00-\x1f\x7f]/u.test(pnpmEntrypoint) || /[\x00-\x1f\x7f]/u.test(nodeExecutable)) {
    throw new Error('dsh: invalid packaged pnpm invocation')
  }
  return {
    command: nodeExecutable,
    args: [pnpmEntrypoint],
    env: {
      PATH: process.platform === 'win32' ? dirname(nodeExecutable)
        : [dirname(nodeExecutable), '/usr/bin', '/bin'].join(delimiter),
      HOME: userHome,
      CI: '1',
    },
  }
}
