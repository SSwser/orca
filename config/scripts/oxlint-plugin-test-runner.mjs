import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { oxlintPath } from './oxlint-executable.mjs'

export function runOxlintPluginOnSource({
  pluginName,
  pluginPath,
  rules,
  source,
  extension = 'tsx'
}) {
  const directory = mkdtempSync(path.join(tmpdir(), `orca-${pluginName}-lint-`))
  const sourcePath = path.join(directory, `sample.${extension}`)
  const configPath = path.join(directory, 'oxlint.json')

  try {
    writeFileSync(sourcePath, source)
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [],
        categories: {
          correctness: 'off',
          suspicious: 'off',
          pedantic: 'off',
          perf: 'off',
          style: 'off',
          restriction: 'off',
          nursery: 'off'
        },
        jsPlugins: [{ name: pluginName, specifier: pluginPath }],
        rules
      })
    )
    const result = spawnSync(
      process.execPath,
      [oxlintPath, '--config', configPath, '--format', 'json', sourcePath],
      { encoding: 'utf8' }
    )
    if (result.error) {
      throw result.error
    }
    if (!result.stdout.trim()) {
      throw new Error(result.stderr || `${pluginName} did not produce Oxlint output`)
    }
    return JSON.parse(result.stdout).diagnostics
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
