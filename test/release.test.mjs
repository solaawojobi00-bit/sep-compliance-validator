import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { selectReleaseTag, tagsOnHead } from "../scripts/release-version.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const releaserc = JSON.parse(readFileSync(join(repoRoot, ".releaserc.json"), "utf-8"));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
const releaseWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf-8");

/** Plugin names as configured, whether written as a bare string or as [name, options]. */
const configuredPlugins = releaserc.plugins.map((p) => (Array.isArray(p) ? p[0] : p));

/**
 * Plugins that commit to the release branch. main requires pull requests and status
 * checks and the workflow authenticates with GITHUB_TOKEN, which can bypass neither, so
 * any of these turns every release run into a GH006 failure after the notes are computed.
 */
const BRANCH_WRITING_PLUGINS = ["@semantic-release/git", "@semantic-release/exec"];

describe(".releaserc.json does not write back to protected main", () => {
  it("configures no plugin that commits to the release branch", () => {
    expect(configuredPlugins.filter((name) => BRANCH_WRITING_PLUGINS.includes(name))).toEqual([]);
  });

  it("configures no changelog file, which only a branch write could persist", () => {
    expect(configuredPlugins).not.toContain("@semantic-release/changelog");
    expect(JSON.stringify(releaserc)).not.toContain("CHANGELOG.md");
  });

  it("still analyses commits, generates notes, and cuts a GitHub release", () => {
    expect(configuredPlugins).toEqual(
      expect.arrayContaining([
        "@semantic-release/commit-analyzer",
        "@semantic-release/release-notes-generator",
        "@semantic-release/github",
      ]),
    );
  });

  it("has no branch-writing plugin installed at all", () => {
    // Removing a plugin from the config but leaving the dependency makes it a one-line
    // change away from being reintroduced; this proves it cannot resolve.
    const require = createRequire(join(repoRoot, "package.json"));
    for (const name of ["@semantic-release/git", "@semantic-release/changelog"]) {
      expect(() => require.resolve(name)).toThrow();
      expect(pkg.devDependencies).not.toHaveProperty(name);
    }
  });

  it("can resolve every plugin it still configures", () => {
    // Dropping two plugins must not have taken an installed one with it: semantic-release
    // only discovers a missing plugin at release time, which is the worst place to find out.
    const require = createRequire(join(repoRoot, "package.json"));
    for (const name of configuredPlugins) {
      expect(() => require.resolve(name), `${name} is configured but not installed`).not.toThrow();
    }
  });

  it("keeps the release checkout credentialed for the tag push", () => {
    // semantic-release's own `git push --tags` goes over this remote; branch protection
    // does not apply to it. Dropping credentials here would break releases a second way.
    expect(releaseWorkflow).toContain("persist-credentials: true");
  });
});

describe("selectReleaseTag", () => {
  it("resolves the version from a single release tag", () => {
    expect(selectReleaseTag(["v0.2.0"])).toEqual({ tag: "v0.2.0", version: "0.2.0" });
  });

  it("ignores tags that are not release tags", () => {
    expect(selectReleaseTag(["latest", "v1", "v1.2", "release-1.2.3", "1.2.3", "v1.2.3"])).toEqual({
      tag: "v1.2.3",
      version: "1.2.3",
    });
  });

  it("accepts prerelease and build metadata versions", () => {
    expect(selectReleaseTag(["v2.0.0-beta.1"])).toEqual({
      tag: "v2.0.0-beta.1",
      version: "2.0.0-beta.1",
    });
  });

  it("refuses a commit with no release tag", () => {
    const result = selectReleaseTag(["nightly"]);
    expect(result.version).toBeUndefined();
    expect(result.error).toContain("no release tag");
    expect(result.error).toContain("nightly");
  });

  it("refuses rather than guesses when two release tags claim the commit", () => {
    const result = selectReleaseTag(["v1.0.0", "v1.0.1"]);
    expect(result.version).toBeUndefined();
    expect(result.error).toContain("more than one release tag");
  });
});

describe("scripts/release-version.mjs against real repositories", () => {
  const scratchDirs = [];

  afterAll(() => {
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A real git repository with one commit per entry in `tags`, tagged as given. */
  function makeRepo(commits) {
    const dir = mkdtempSync(join(tmpdir(), "release-version-"));
    scratchDirs.push(dir);
    const git = (...args) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
        cwd: dir,
        encoding: "utf-8",
      });

    git("init", "-q", "-b", "main");
    for (const [index, tags] of commits.entries()) {
      writeFileSync(join(dir, `file-${index}.txt`), `${index}\n`);
      git("add", ".");
      git("commit", "-q", "-m", `commit ${index}`);
      for (const tag of tags) {
        git("tag", tag);
      }
    }
    return dir;
  }

  /** Runs the script the way publish.yml does, including its GITHUB_OUTPUT file. */
  function runScript(cwd) {
    const outputFile = join(mkdtempSync(join(tmpdir(), "release-output-")), "out.txt");
    scratchDirs.push(outputFile);
    writeFileSync(outputFile, "");
    const script = join(repoRoot, "scripts", "release-version.mjs");
    try {
      const stdout = execFileSync(process.execPath, [script, cwd], {
        encoding: "utf-8",
        env: { ...process.env, GITHUB_OUTPUT: outputFile },
      });
      return { status: 0, stdout, output: readFileSync(outputFile, "utf-8"), stderr: "" };
    } catch (err) {
      return {
        status: err.status,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        output: readFileSync(outputFile, "utf-8"),
      };
    }
  }

  it("reads the tags git reports for HEAD", () => {
    const dir = makeRepo([["v0.1.0"], ["v0.2.0", "nightly"]]);
    expect(tagsOnHead(dir).sort()).toEqual(["nightly", "v0.2.0"]);
  });

  it("publishes the version of the tag on HEAD", () => {
    const dir = makeRepo([["v0.1.0"], ["v0.2.0"]]);
    const run = runScript(dir);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("0.2.0");
    expect(run.output).toBe("version=0.2.0\ntag=v0.2.0\n");
  });

  it("fails when the release tag is on an earlier commit than HEAD", () => {
    // The old guard compared package.json's version to a tag anywhere in history; this is
    // the case that must still be rejected now that the tag alone decides.
    const dir = makeRepo([["v0.2.0"], []]);
    const run = runScript(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("::error::");
    expect(run.output).toBe("");
  });

  it("fails on an untagged commit", () => {
    const run = runScript(makeRepo([[]]));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no release tag");
  });

  it("fails on a commit tagged with something that is not a release", () => {
    const run = runScript(makeRepo([["nightly"]]));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("no release tag");
  });

  it("fails rather than choosing between two release tags on HEAD", () => {
    const run = runScript(makeRepo([["v1.0.0", "v1.0.1"]]));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("more than one release tag");
    expect(run.output).toBe("");
  });

  it("reports a usable error outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-norepo-"));
    scratchDirs.push(dir);
    const run = runScript(dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("Cannot read tags");
  });
});
