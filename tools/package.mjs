// Fix job, after Claude: turns Claude's edits into a patch without running git in
// the workspace Claude worked in. A fresh clone of the base commit is made
// outside the workspace; only the files a fix may change are copied across, and
// only if they are plain files; git runs in the clone.
//
// Env: PKG_WORKSPACE, PKG_BASE_SHA, PKG_OUT, PKG_PM, PKG_DIRS, PKG_CODE_PATHS,
//      GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_TOKEN (read-only), RUNNER_TEMP
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCKFILES, normCodePaths } from "./checks.mjs";

const env = process.env;
const ws = env.PKG_WORKSPACE;
const outDir = env.PKG_OUT;
const sha = env.PKG_BASE_SHA;
if (!/^[0-9a-f]{40}$/.test(sha || "")) throw new Error("PKG_BASE_SHA must be a commit SHA");
const dirs = (env.PKG_DIRS || ".").split(/\s+/).filter(Boolean);
const codePaths = normCodePaths((env.PKG_CODE_PATHS || "").split(/\s+/));
const rel = (d, f) => (d === "." ? f : `${d}/${f}`);
const plain = (p) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

const clone = mkdtempSync(join(env.RUNNER_TEMP || "/tmp", "pack-"));
const git = (args, opts = {}) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: clone, encoding: "utf8", maxBuffer: 64 << 20, ...opts,
  });
git(["init", "-q"]);
const auth = "AUTHORIZATION: basic " + Buffer.from(`x-access-token:${env.GITHUB_TOKEN}`).toString("base64");
// PKG_REMOTE is for the kit's own tests; the workflow never sets it.
const remote = env.PKG_REMOTE || `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`;
git(["-c", `http.extraheader=${auth}`, "fetch", "-q", "--depth", "1", remote, sha]);
git(["checkout", "-q", "FETCH_HEAD"]);

// The files a fix may change, as they are on the base commit.
const allowed = new Set();
for (const d of dirs) {
  allowed.add(rel(d, "package.json"));
  allowed.add(rel(d, LOCKFILES[env.PKG_PM]));
}
if (codePaths.length) {
  for (const f of git(["ls-files", "-z", "--", ...codePaths]).split("\0").filter(Boolean)) allowed.add(f);
}
let copied = 0;
for (const f of allowed) {
  const src = join(ws, f), dst = join(clone, f);
  if (!plain(dst) || !plain(src)) continue; // only existing plain files, never links
  copyFileSync(src, dst);
  copied++;
}
git(["add", "-A"]);
const patch = git(["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"]);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "change.patch"), patch);
writeFileSync(join(outDir, "base.sha"), sha + "\n");
for (const f of ["title.txt", "body.md"]) {
  const p = join(ws, ".claude-pr", f);
  writeFileSync(join(outDir, f), plain(p) ? readFileSync(p).subarray(0, 40000) : "");
}
console.log(`Packaged ${patch.length} bytes from ${copied} allowed files.`);
