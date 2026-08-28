import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')

export function resolveOxlintPath(packageRoot = repositoryRoot) {
  const requireFromPackage = createRequire(path.join(packageRoot, 'package.json'))
  const packageDirectory = path.dirname(requireFromPackage.resolve('oxlint/package.json'))
  return path.join(packageDirectory, 'bin', 'oxlint')
}

export const oxlintPath = resolveOxlintPath()

export function runOxlint(args, packageRoot = process.cwd()) {
  const result = spawnSync(process.execPath, [resolveOxlintPath(packageRoot), ...args], {
    stdio: 'inherit'
  })
  if (result.error) {
    throw result.error
  }
  return result.status ?? 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runOxlint(process.argv.slice(2))
}
