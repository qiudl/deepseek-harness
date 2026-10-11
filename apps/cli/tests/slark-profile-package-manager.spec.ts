import { dirname, delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { slarkProfilePackageManager } from '../src/slark-profile-package-manager.ts'

it('uses the Host-supplied packaged pnpm only for a Slark Web Profile worker', () => {
  const node = join(tmpdir(), 'packaged', 'node', 'bin', 'node')
  const pnpm = join(tmpdir(), 'packaged', 'pnpm', 'bin', 'pnpm.mjs')
  const userHome = join(tmpdir(), 'person')
  const expected = {
    command: node,
    args: [pnpm],
    env: { PATH: process.platform === 'win32' ? dirname(node)
      : `${dirname(node)}${delimiter}/usr/bin${delimiter}/bin`, HOME: userHome, CI: '1' },
  }
  expect(slarkProfilePackageManager('web', {
    DSH_SLARK_EMBEDDED: '1', DSH_PROFILE_PNPM_ENTRYPOINT: pnpm,
  }, node, userHome)).toEqual(expected)
  expect(slarkProfilePackageManager('headless', {
    DSH_SLARK_EMBEDDED: '1', DSH_PROFILE_PNPM_ENTRYPOINT: pnpm,
  }, node, userHome)).toBeUndefined()
  expect(slarkProfilePackageManager('web', {
    DSH_PROFILE_PNPM_ENTRYPOINT: pnpm,
  }, node, userHome)).toBeUndefined()
  expect(slarkProfilePackageManager('web', { DSH_SLARK_EMBEDDED: '1' }, node, userHome)).toBeUndefined()
  expect(() => slarkProfilePackageManager('web', {
    DSH_SLARK_EMBEDDED: '1', DSH_PROFILE_PNPM_ENTRYPOINT: 'pnpm',
  }, node, userHome)).toThrow()
})
