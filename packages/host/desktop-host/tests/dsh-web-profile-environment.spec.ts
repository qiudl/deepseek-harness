import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { PROFILE_ENVIRONMENT_HANDOFF } from '../src/dsh-web-profile-worker.ts'

/**
 * Run the bootstrap's own handoff source against an isolated environment.
 * @param initial - what the spawning Host left in the child's environment block.
 * @param environment - the Profile environment handed over on fd 3.
 * @returns the environment the Profile ends up running with.
 */
function handoff(
  initial: Record<string, string>,
  environment: Record<string, string>,
): Record<string, string> {
  const env = { ...initial }
  runInNewContext(PROFILE_ENVIRONMENT_HANDOFF, { process: { env }, input: { environment } })
  return env
}

describe('Windows Profile environment handoff', () => {
  it('drops the ambient environment the Host did not hand over', () => {
    const result = handoff(
      { AWS_SECRET_ACCESS_KEY: 'leak', PATH: 'C:\\tools', USERPROFILE: 'C:\\Users\\alice' },
      { DSH_PROFILE_ID: 'p1' },
    )

    expect(result).toEqual({ DSH_PROFILE_ID: 'p1' })
  })

  it('keeps the OS variables every node child needs to seed its CSPRNG', () => {
    // A child that loses SystemRoot aborts in InitializeOncePerProcess before running any script.
    const result = handoff(
      { SystemRoot: 'C:\\WINDOWS', windir: 'C:\\WINDOWS', SystemDrive: 'C:', SECRET: 'leak' },
      { TEMP: 'C:\\profile\\temp' },
    )

    expect(result).toEqual({
      SystemRoot: 'C:\\WINDOWS',
      windir: 'C:\\WINDOWS',
      SystemDrive: 'C:',
      TEMP: 'C:\\profile\\temp',
    })
  })

  it('matches the OS variables however Windows cased them', () => {
    const result = handoff({ SYSTEMROOT: 'C:\\WINDOWS', WinDir: 'C:\\WINDOWS' }, {})

    expect(result).toEqual({ SYSTEMROOT: 'C:\\WINDOWS', WinDir: 'C:\\WINDOWS' })
  })

  it('lets the Host override an OS variable it handed over itself', () => {
    const result = handoff({ SystemRoot: 'C:\\WINDOWS' }, { SystemRoot: 'D:\\WINDOWS' })

    expect(result).toEqual({ SystemRoot: 'D:\\WINDOWS' })
  })
})
