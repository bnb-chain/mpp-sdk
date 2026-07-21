import assert from 'node:assert/strict'
import test from 'node:test'

import { compareStableVersions } from './check-version-regression.mjs'

test('detects the release regression that blocked the B402 publish', () => {
  assert.equal(compareStableVersions('0.2.0', '0.3.0'), -1)
})

test('accepts unchanged and increasing stable versions', () => {
  assert.equal(compareStableVersions('0.3.0', '0.3.0'), 0)
  assert.equal(compareStableVersions('0.3.1', '0.3.0'), 1)
  assert.equal(compareStableVersions('0.4.0', '0.3.9'), 1)
  assert.equal(compareStableVersions('1.0.0', '0.99.99'), 1)
})

test('rejects versions outside the repository stable-version policy', () => {
  assert.throws(() => compareStableVersions('0.4.0-beta.1', '0.3.0'), /stable semver/)
})
