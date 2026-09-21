/** Return the clang architecture name for the current macOS Node process. */
export function darwinCompilerArchitecture(arch: NodeJS.Architecture): 'arm64' | 'x86_64' {
  if (arch === 'arm64') return 'arm64'
  if (arch === 'x64') return 'x86_64'
  throw new Error(`build: unsupported macOS architecture ${arch}`)
}
