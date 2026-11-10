#!/usr/bin/env bash
# Publish the checkout's version unless npm already has that exact version.
# The first release is published by hand so npm can add a trusted publisher.
# This lives outside the workflow so tests can run it without GitHub Actions.
set -euo pipefail

name=$(node -p 'require("./package.json").name')
version=$(node -p 'require("./package.json").version')
if [ "$(npm view "$name@$version" version 2>/dev/null)" = "$version" ]; then
  echo "::notice::$name@$version is on npm already; not published again"
else
  npm publish
fi
