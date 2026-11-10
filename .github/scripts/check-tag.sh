#!/usr/bin/env bash
# The v<version> tag must name the version package.json publishes. This lives
# outside the workflow so tests can run it without GitHub Actions.
set -euo pipefail

version=$(node -p 'require("./package.json").version')
if [ "${GITHUB_REF_NAME:-}" != "v$version" ]; then
  echo "::error::tag ${GITHUB_REF_NAME:-}, but package.json is $version"
  exit 1
fi
