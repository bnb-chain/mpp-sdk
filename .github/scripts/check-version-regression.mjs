#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

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

  const current = packageVersion(readFileSync('package.json', 'utf8'), 'package.json')
  const baseline = packageVersion(
    execFileSync('git', ['show', `${baseRevision}:package.json`], { encoding: 'utf8' }),
    `${baseRevision}:package.json`,
  )

  if (compareStableVersions(current, baseline) < 0) {
    console.error(
      `::error title=Package version regression::package.json regressed from ${baseline} to ${current}. Feature branches must never lower an already released version.`,
    )
    process.exitCode = 1
    return
  }

  console.log(`Package version ${current} does not regress base version ${baseline}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkVersionRegression(process.argv[2])
}
