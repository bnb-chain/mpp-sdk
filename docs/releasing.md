# Releasing

How `@bnb-chain/mpp` versions and ships to npm. Day-to-day you only do
two things: add a changeset with your PR, and merge the version PR when
you want a release to go out. Everything else is automated by
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

## Day-to-day flow

1. **Every user-visible PR adds a changeset** — run `pnpm changeset`
   (or write `.changeset/<slug>.md` by hand) describing the change and
   its semver bump. PRs without behavior changes (docs, CI) skip this.
2. **Merge to `v1`** — the `release` workflow runs `verify`
   (lint / types / tests / build), then the changesets action opens or
   updates a **`chore: version package`** PR. That PR consumes all
   pending `.changeset/*.md` files, bumps `package.json#version`, and
   regenerates `CHANGELOG.md`.
3. **Merge the version PR** — the same workflow now publishes:
   `zile publish:prepare && changeset publish && zile publish:post`,
   then pushes the `v<version>` git tag and creates the GitHub Release.
   npm provenance is attested automatically via OIDC.

Nothing publishes from a workstation; the version PR is the release
button.

## One-time setup (repo + npm admins)

### 1. GitHub repo settings

- **Settings → Actions → General → Workflow permissions**: enable
  **"Allow GitHub Actions to create and approve pull requests"** —
  without it the changesets action cannot open the version PR.

### 2. First publish (bootstrap)

npm Trusted Publishing is configured per-package on npmjs.com, so the
package must exist before the workflow can publish unattended. For the
first release (e.g. `0.1.0`), publish once from a workstation with npm
publish rights on the `@bnb-chain` org:

```bash
pnpm install && pnpm build
pnpm changeset:version           # consume changesets -> bump version + CHANGELOG
npm login                        # an account with publish rights on @bnb-chain
pnpm changeset:publish           # zile publish:prepare + changeset publish + post
git push --follow-tags           # push the version commit + v0.1.0 tag (feature branch / PR)
```

(`access: public` comes from `.changeset/config.json`; scoped packages
default to restricted without it.)

### 3. npm Trusted Publishing (after the package exists)

On npmjs.com → `@bnb-chain/mpp` → **Settings → Trusted Publisher**:

- Publisher: **GitHub Actions**
- Organization: `bnb-chain` · Repository: `mpp-sdk`
- Workflow filename: `release.yml` · Environment: _(leave empty)_

From then on the workflow needs no npm token (`id-token: write` +
npm ≥ 11.5.1 on the runner — the workflow upgrades npm itself), and
every publish carries a provenance attestation.

**Token fallback**: if Trusted Publishing can't be used, create a
granular npm access token with read/write on `@bnb-chain/mpp`, store it
as the `NPM_TOKEN` repo secret, and uncomment the two `env` lines at the
bottom of `release.yml`.

## Branch map

- `v1` — release base branch (`.changeset/config.json#baseBranch`).
  Pushes here drive the workflow.
- Feature branches → PR into `v1`; `verify.yml` runs on the PR.

## Sanity checks

```bash
pnpm changeset status             # what's pending + the computed bump
pnpm changeset:version            # dry-run locally on a branch (don't commit if just inspecting)
pnpm build && npm publish --dry-run  # inspect the exact publish tarball
```
