#!/usr/bin/env node
/**
 * The first `##` section of CHANGELOG.md must name the version package.json
 * publishes. A release commit changes both; a mismatch means the changelog
 * does not describe what the tag will publish.
 */
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync("package.json", "utf8"));
} catch {
  fail("package.json is missing or invalid");
}
if (
  typeof pkg !== "object" ||
  pkg === null ||
  typeof pkg.version !== "string"
) {
  fail("package.json has no version");
}

let changelog;
try {
  changelog = readFileSync("CHANGELOG.md", "utf8");
} catch {
  fail("CHANGELOG.md is missing");
}
const first = /^##\s+(.+?)\s*$/m.exec(changelog)?.[1];
if (first !== pkg.version) {
  console.error(
    `::error::CHANGELOG.md top section ${first ?? "missing"}, but package.json is ${pkg.version}`,
  );
  process.exit(1);
}
