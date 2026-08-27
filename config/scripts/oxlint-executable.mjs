import { createRequire } from 'node:module'
import path from 'node:path'

const oxlintPackageDirectory = path.dirname(
  createRequire(import.meta.url).resolve('oxlint/package.json')
)

export const oxlintPath = path.join(oxlintPackageDirectory, 'bin', 'oxlint')
