#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PUBLISHABLE_PACKAGES = [
  'package.json',
  'packages/b402/package.json',
  'packages/mpp-b402/package.json',
]

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Compare two stable semantic versions.
 *
 * @returns {-1 | 0 | 1}
 */
export function compareStableVersions(candidate, baseline) {
  const candidateParts = parseStableVersion(candidate)
  const baselineParts = parseStableVersion(baseline)

  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] < baselineParts[index]) return -1
    if (candidateParts[index] > baselineParts[index]) return 1
  }
  return 0
}

function parseStableVersion(version) {
  const match = STABLE_SEMVER.exec(version)
  if (!match) {
    throw new Error(`Expected a stable semver (x.y.z), received ${JSON.stringify(version)}`)
  }
  return match.slice(1).map(Number)
}

function packageVersion(contents, source) {
  const value = JSON.parse(contents).version
  if (typeof value !== 'string') throw new Error(`${source} has no string package version`)
  return value
}

function checkVersionRegression(baseRevision) {
  if (!baseRevision) throw new Error('Usage: check-version-regression.mjs <base-revision>')

  for (const packagePath of PUBLISHABLE_PACKAGES) {
    const current = packageVersion(readFileSync(packagePath, 'utf8'), packagePath)
    let baselineContents
    try {
      baselineContents = execFileSync('git', ['show', `${baseRevision}:${packagePath}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      console.log(`Package ${packagePath} is new relative to ${baseRevision}; no regression check.`)
      continue
    }
    const baseline = packageVersion(baselineContents, `${baseRevision}:${packagePath}`)

    if (compareStableVersions(current, baseline) < 0) {
      console.error(
        `::error title=Package version regression::${packagePath} regressed from ${baseline} to ${current}. Feature branches must never lower an already released version.`,
      )
      process.exitCode = 1
      continue
    }

    console.log(`${packagePath} version ${current} does not regress base version ${baseline}.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkVersionRegression(process.argv[2])
}
