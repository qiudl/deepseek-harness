import type { ProfileRegistry } from '../src/profile-registry.ts'

/**
 * Instance-local JSON storage for protocol tests; native file security has separate owning suites.
 * @returns Independent registry storage hooks that serialize each committed snapshot.
 */
export function registryFileFixture(): Pick<ConstructorParameters<typeof ProfileRegistry>[0],
  'prepareRoot' | 'loadSnapshot' | 'persistSnapshot'> {
  let contents: string | undefined
  return {
    prepareRoot: () => undefined,
    loadSnapshot: () => {
      const snapshot: unknown = contents === undefined ? undefined : JSON.parse(contents)
      return snapshot
    },
    persistSnapshot: (_path, _root, snapshot) => { contents = JSON.stringify(snapshot) },
  }
}
