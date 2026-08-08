#!/usr/bin/env bash
#
# Publishes Nextwise into a subfolder of the personal website repo, which
# GitHub Pages serves straight from the branch root.
#
#   https://www.anthonymlortiz.com/nextwise/
#
# The build output is committed to that repo rather than built by CI, so the
# website keeps its plain branch-deploy and needs no Node toolchain of its own.
#
#   SITE_REPO   path to a clone of the website repo   (default ../website)
#   SITE_PATH   subfolder to publish into             (default nextwise)
#
# The base path has to be baked in at build time (it rewrites every asset URL
# and is what `appUrl()` reads for the OAuth redirect URI), so SITE_PATH is
# passed to the build rather than only deciding where files land.
set -euo pipefail

cd "$(dirname "$0")/.."
project_root="$PWD"

site_repo="${SITE_REPO:-../website}"
site_path="${SITE_PATH:-nextwise}"

# A stray slash here would make rsync --delete run against the wrong directory,
# and the target repo holds the live site.
if [[ ! "$site_path" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "SITE_PATH must be a single folder name, got: $site_path" >&2
  exit 1
fi

if [[ ! -d "$site_repo/.git" ]]; then
  echo "Not a git clone: $site_repo" >&2
  echo "Clone it first:  gh repo clone anthonymlortiz/website $site_repo" >&2
  exit 1
fi

site_repo="$(cd "$site_repo" && pwd)"

# Publishing on top of someone else's uncommitted work would sweep it into this
# commit, so refuse unless everything outside the published folder is clean.
if [[ -n "$(git -C "$site_repo" status --porcelain -- . ":(exclude)$site_path")" ]]; then
  echo "The website repo has uncommitted changes outside $site_path/:" >&2
  git -C "$site_repo" status --short -- . ":(exclude)$site_path" >&2
  exit 1
fi

echo "==> Updating $site_repo"
git -C "$site_repo" pull --ff-only

echo "==> Building for /$site_path/"
BASE_PATH="/$site_path/" npm run build

# Record which source commit produced this build. Without it the published
# bundle cannot be traced back to anything, since dist/ is not versioned.
source_sha="$(git -C "$project_root" rev-parse --short HEAD 2>/dev/null || echo unknown)"
source_dirty=""
if [[ -n "$(git -C "$project_root" status --porcelain 2>/dev/null)" ]]; then
  source_dirty=" (uncommitted changes)"
  echo "!!  Source tree has uncommitted changes; this build is not reproducible from git." >&2
fi

echo "==> Syncing dist/ into $site_path/"
mkdir -p "$site_repo/$site_path"
# --delete so a renamed hashed asset does not leave its predecessor behind.
rsync -a --delete "$project_root/dist/" "$site_repo/$site_path/"

# Pages runs Jekyll on branch deploys, which drops paths beginning with an
# underscore. Vite does not emit any today, but the failure mode is a silent
# 404 on one asset, so opt out rather than depend on that staying true.
if [[ ! -f "$site_repo/.nojekyll" ]]; then
  touch "$site_repo/.nojekyll"
  echo "==> Added .nojekyll"
fi

cd "$site_repo"
git add -A -- "$site_path" .nojekyll

if git diff --cached --quiet; then
  echo "==> No changes to publish."
  exit 0
fi

git commit -q -m "Deploy Nextwise to /$site_path/" -m "Built from nextwise@${source_sha}${source_dirty}"
git push -q

echo
echo "Deployed. Live in a minute or so at:"
echo "  https://www.anthonymlortiz.com/$site_path/"
