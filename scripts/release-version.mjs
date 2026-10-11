#!/usr/bin/env node
/**
 * Resolves the version publish.yml is about to publish from the release tag on HEAD.
 *
 * semantic-release does not write the version back to main — main is protected and the
 * workflow's GITHUB_TOKEN cannot push to it (see issue #172) — so package.json on main
 * stays at its committed value and the tag is the only record of what was released.
 * This script is therefore what makes "publish only a released commit" checkable: it
 * refuses anything but a commit carrying exactly one `v<semver>` tag.
 *
 * Usage: node scripts/release-version.mjs [repo-dir]
 *
 * Prints the version to stdout and, when GITHUB_OUTPUT is set, appends `version=` and
 * `tag=` to it. Exits 1 with a workflow error annotation if HEAD is not a released commit.
 */
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

/**
 * The tag shape semantic-release produces here (`v` + a semver version). Prereleases and
 * build metadata are accepted so a future prerelease branch does not silently resolve to
 * nothing; anything else — `v1`, `latest`, `release-1.2.3` — is not a release tag.
 */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Picks the release tag out of every tag pointing at a commit.
 *
 * Deliberately refuses rather than guesses when there is more than one: two release tags
 * on one commit means two versions claim it, and picking either publishes an immutable
 * npm version that may not be the one intended.
 *
 * @param {string[]} tags Tag names pointing at the commit, in any order.
 * @returns {{ tag: string, version: string } | { error: string }}
 */
export function selectReleaseTag(tags) {
  const releaseTags = tags.map((t) => t.trim()).filter((t) => RELEASE_TAG.test(t));

  if (releaseTags.length === 0) {
    return {
      error:
        "HEAD carries no release tag, so it is not a commit semantic-release has released. " +
        `Dispatch this workflow against a released commit. Tags on HEAD: ${
          tags.length > 0 ? tags.join(", ") : "(none)"
        }`,
    };
  }

  if (releaseTags.length > 1) {
    return {
      error: `HEAD carries more than one release tag (${releaseTags.join(
        ", ",
      )}); which version to publish is ambiguous.`,
    };
  }

  return { tag: releaseTags[0], version: releaseTags[0].slice(1) };
}

/**
 * Every tag pointing at HEAD in `cwd`, as git reports them.
 *
 * @param {string} cwd Repository directory.
 * @returns {string[]}
 */
export function tagsOnHead(cwd) {
  const out = execFileSync("git", ["tag", "--points-at", "HEAD"], {
    cwd,
    encoding: "utf-8",
  });
  return out.split("\n").filter((line) => line.trim() !== "");
}

// Only when run directly: the exports above are unit-tested.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cwd = resolve(process.argv[2] ?? repoRoot);

  let tags;
  try {
    tags = tagsOnHead(cwd);
  } catch (err) {
    console.error(`::error::Cannot read tags in ${cwd}: ${err.message}`);
    process.exit(1);
  }

  const resolved = selectReleaseTag(tags);
  if ("error" in resolved) {
    console.error(`::error::${resolved.error}`);
    process.exit(1);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${resolved.version}\ntag=${resolved.tag}\n`);
  }
  console.log(resolved.version);
}
