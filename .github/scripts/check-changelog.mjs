#!/usr/bin/env node
/**
 * The first `##` section outside a fenced block or an HTML comment must name
 * the version package.json publishes. A release commit changes both; a
 * mismatch means the changelog does not describe what the tag will publish.
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
function firstSection(text) {
  let fence;
  let comment = false;
  for (const line of text.split(/\r?\n/)) {
    if (comment) {
      if (line.includes("-->")) comment = false;
      continue;
    }
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) comment = true;
      continue;
    }
    const section = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (section) return section[1];
  }
  return undefined;
}

const first = firstSection(changelog);
if (first !== pkg.version) {
  console.error(
    `::error::CHANGELOG.md top section ${first ?? "missing"}, but package.json is ${pkg.version}`,
  );
  process.exit(1);
}
