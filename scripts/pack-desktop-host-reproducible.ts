/** Produce a byte-reproducible desktop-host npm tarball from pnpm's rewritten manifest. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const FIXED_TIME = new Date('1985-10-26T17:45:00.000Z')

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map(key => [key, canonical((value as Record<string, unknown>)[key])]))
}

function filesBelow(root: string, relative = 'package'): string[] {
  const result: string[] = []
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const nested = `${prefix}/${name}`
      const metadata = lstatSync(path)
      if (metadata.isSymbolicLink()) throw new Error(`reproducible pack refuses symlink: ${nested}`)
      if (metadata.isDirectory()) visit(path, nested)
      else if (metadata.isFile()) result.push(nested)
      else throw new Error(`reproducible pack refuses special file: ${nested}`)
    }
  }
  visit(root, relative)
  return result
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index < 0 || value === undefined || value.startsWith('--')) throw new Error(`${name} is required`)
  return resolve(value)
}

const destination = argument('--destination')
const repository = resolve(import.meta.dirname, '..')
const packageRoot = join(repository, 'packages', 'host', 'desktop-host')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-pack-'))

try {
  const raw = join(temporary, 'raw')
  const extracted = join(temporary, 'extracted')
  mkdirSync(raw)
  mkdirSync(extracted)
  execFileSync('pnpm', ['pack', '--pack-destination', raw], { cwd: packageRoot, stdio: 'pipe' })
  const archives = readdirSync(raw).filter(name => name.endsWith('.tgz'))
  if (archives.length !== 1) throw new Error('pnpm pack did not produce exactly one tarball')
  execFileSync('/usr/bin/tar', ['-xzf', join(raw, archives[0] as string), '-C', extracted])

  const stagedPackage = join(extracted, 'package')
  const manifestPath = join(stagedPackage, 'package.json')
  const manifest = canonical(JSON.parse(readFileSync(manifestPath, 'utf8'))) as Record<string, unknown>
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const files = filesBelow(stagedPackage)
  for (const file of files) utimesSync(join(extracted, file), FIXED_TIME, FIXED_TIME)
  const list = join(temporary, 'files.txt')
  writeFileSync(list, `${files.join('\n')}\n`)

  const tarPath = join(temporary, 'package.tar')
  execFileSync('/usr/bin/tar', [
    '--format', 'ustar', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root',
    '-cf', tarPath, '-C', extracted, '-T', list,
  ], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const archive = execFileSync('/usr/bin/gzip', ['-n', '-9', '-c', tarPath], { maxBuffer: 64 * 1024 * 1024 })
  mkdirSync(destination, { recursive: true })
  const output = join(destination, basename(archives[0] as string))
  writeFileSync(output, archive)
  process.stdout.write(`${JSON.stringify({
    archive: output,
    sha256: sha256(output),
    startupSha256: sha256(join(stagedPackage, 'lib', 'startup.js')),
    clientSha256: sha256(join(stagedPackage, 'lib', 'host-control-client.js')),
    files: files.length,
  })}\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
