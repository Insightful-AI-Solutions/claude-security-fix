// Verify job: checks Claude's change and builds the change that is published.
// No Claude and no write token here.
//
// Claude's lockfiles are never published. For each project whose package.json
// changed, this job rebuilds the lockfile from the default branch's lockfile
// plus the new package.json, with the package manager in an empty environment,
// scripts off, npm registry only. So a lockfile cannot be edited by hand, in any
// format. It then audits the result, so the pull request shows counts that the
// workflow measured itself.
//
// Env: VERIFY_PM (npm|pnpm|bun), VERIFY_DIRS, VERIFY_CODE_PATHS, VERIFY_PROTECTED,
//      VERIFY_BUNDLE (change.patch, base.sha, title.txt, body.md from the fix job),
//      VERIFY_WORKSPACE (checkout of base.sha), VERIFY_OUT (folder for the result),
//      GITHUB_OUTPUT, RUNNER_TEMP
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import {
  LOCKFILES, buildPackageJson, cleanTitle, credentialProblems, lockDowngrades, lockPackageNames, neutralise, pathProblems, patchShapeProblems,
} from "./checks.mjs";

const env = process.env;
const pm = env.VERIFY_PM;
const dirs = (env.VERIFY_DIRS || ".").split(/\s+/).filter(Boolean);
const codePaths = (env.VERIFY_CODE_PATHS || "").split(/\s+/).filter(Boolean);
const protectedPaths = (env.VERIFY_PROTECTED || "").split(/\s+/).filter(Boolean);
const ws = env.VERIFY_WORKSPACE;
const bundle = env.VERIFY_BUNDLE;
const outDir = env.VERIFY_OUT;
const problems = [];

const out = (k, v) => {
  const d = "EOF_" + randomBytes(12).toString("hex");
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${k}<<${d}\n${String(v)}\n${d}\n`);
};
const git = (args, opts = {}) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
    cwd: ws, encoding: "utf8", maxBuffer: 64 << 20, ...opts,
  });
const plainFile = (p) => existsSync(p) && lstatSync(p).isFile();
const readBundle = (f, max) => {
  const p = join(bundle, f);
  if (!plainFile(p)) return "";
  const s = readFileSync(p, "utf8");
  if (s.length > max) problems.push(`${f}: longer than ${max} characters`);
  return s.slice(0, max);
};
const rel = (d, f) => (d === "." ? f : `${d}/${f}`);

// Proxy settings hold no credentials and pass through; nothing else does.
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];
function pmEnv(home) {
  const pass = Object.fromEntries(PROXY_VARS.filter((v) => env[v]).map((v) => [v, env[v]]));
  return {
    ...pass,
    PATH: env.PATH, HOME: home, TMPDIR: home, XDG_CACHE_HOME: join(home, "cache"),
    npm_config_cache: join(home, "npm"), npm_config_store_dir: join(home, "store"),
    BUN_INSTALL_CACHE_DIR: join(home, "bun"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_pnpmfile: "true", npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
  };
}

// Lockfile from the default branch's lockfile and config plus the new package.json.
function rebuildLockfile(d, newPackageJson) {
  const tmp = mkdtempSync(join(env.RUNNER_TEMP || "/tmp", "rebuild-"));
  const home = join(tmp, ".home");
  mkdirSync(home);
  const lock = LOCKFILES[pm];
  for (const f of [lock, ".npmrc", "bunfig.toml", "pnpm-workspace.yaml"]) {
    try {
      writeFileSync(join(tmp, f), git(["show", `HEAD:${rel(d, f)}`], { stdio: ["ignore", "pipe", "ignore"] }));
    } catch {}
  }
  // Patches named by patchedDependencies, from the default branch.
  try {
    for (const f of git(["ls-tree", "-r", "--name-only", "HEAD", "--", rel(d, "patches")]).split("\n").filter(Boolean)) {
      const target = join(tmp, f.slice(d === "." ? 0 : d.length + 1));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, git(["show", `HEAD:${f}`]));
    }
  } catch {}
  writeFileSync(join(tmp, "package.json"), newPackageJson);
  const cmd = {
    npm: ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    pnpm: ["pnpm", "install", "--lockfile-only", "--ignore-scripts"],
    bun: ["bun", "install", "--lockfile-only", "--ignore-scripts"],
  }[pm];
  try {
    execFileSync(cmd[0], cmd.slice(1), { cwd: tmp, stdio: ["ignore", "ignore", "ignore"], env: pmEnv(home) });
  } catch {
    problems.push(`${rel(d, lock)}: ${pm} could not build the lockfile from package.json`);
    return null;
  }
  return readFileSync(join(tmp, lock), "utf8");
}

// Audit counts by severity, measured by the workflow on the final lockfile.
// Returns null unless the output has the shape of a real audit result. A registry
// or network failure can also print valid JSON, and that must never count as
// "no findings".
export function auditCounts(pmName, json) {
  const sev = { critical: 0, high: 0, moderate: 0, low: 0 };
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  if ("error" in json || "errors" in json || "code" in json) return null;
  if (pmName === "bun") {
    const seen = new Set();
    for (const list of Object.values(json)) {
      if (!Array.isArray(list)) return null;
      for (const a of list) {
        if (!a || typeof a !== "object" || a.id === undefined || typeof a.severity !== "string") return null;
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        if (a.severity in sev) sev[a.severity]++;
      }
    }
  } else {
    const v = json.metadata?.vulnerabilities;
    if (!v || typeof v !== "object") return null;
    for (const k of Object.keys(sev)) {
      if (!Number.isInteger(v[k]) || v[k] < 0) return null;
      sev[k] = v[k];
    }
  }
  return sev;
}
function audit(d, fromBase) {
  const tmp = mkdtempSync(join(env.RUNNER_TEMP || "/tmp", "audit-"));
  const home = join(tmp, ".home");
  mkdirSync(home);
  const lock = LOCKFILES[pm];
  for (const f of ["package.json", lock, ".npmrc", "bunfig.toml", "pnpm-workspace.yaml"]) {
    if (fromBase) {
      try { writeFileSync(join(tmp, f), git(["show", `HEAD:${rel(d, f)}`], { stdio: ["ignore", "pipe", "ignore"] })); } catch {}
    } else if (plainFile(join(ws, rel(d, f)))) writeFileSync(join(tmp, f), readFileSync(join(ws, rel(d, f))));
  }
  let raw = "";
  try {
    raw = execFileSync(pm, ["audit", "--json"], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: pmEnv(home), maxBuffer: 64 << 20 });
  } catch (e) {
    raw = e.stdout || ""; // audit exits non-zero when it finds anything
  }
  try {
    return auditCounts(pm, JSON.parse(raw));
  } catch {
    return null;
  }
}

function main() {
  mkdirSync(outDir, { recursive: true });
  const baseSha = readBundle("base.sha", 100).trim();
  const head = git(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(baseSha) || baseSha !== head) problems.push("base.sha does not match the checked-out commit");
  const title = cleanTitle(readBundle("title.txt", 2000));
  let body = readBundle("body.md", 30000);
  const patchPath = join(bundle, "change.patch");
  const patch = plainFile(patchPath) ? readFileSync(patchPath) : Buffer.alloc(0);
  if (patch.length > 5 << 20) problems.push("change.patch is larger than 5 MB");
  problems.push(...credentialProblems(patch.toString("utf8"), "the change"));
  problems.push(...credentialProblems(title, "title.txt"));
  problems.push(...credentialProblems(body, "body.md"));
  if (!body.trim()) problems.push("body.md is empty");

  let changed = false;
  const audits = [];
  const warnings = [];
  const lockOnly = [];
  if (patch.length > 0 && !problems.length) {
    if (!title) problems.push("title.txt is empty");
    const shape = patchShapeProblems(git(["apply", "--numstat", "--summary", patchPath]));
    problems.push(...shape.bad);
    problems.push(...pathProblems(shape.paths, { pm, projectDirs: dirs, codePaths, protectedPaths }));
    const locks = dirs.map((d) => rel(d, LOCKFILES[pm]));
    if (!problems.length) {
      try {
        // Everything except the lockfiles, which are rebuilt below.
        const ex = locks.flatMap((l) => ["--exclude", l]);
        git(["apply", "--check", ...ex, patchPath]);
        git(["apply", ...ex, patchPath]);
      } catch {
        problems.push("the change does not apply cleanly to the base commit");
      }
    }
    if (!problems.length) {
      for (const d of dirs) {
        const pj = rel(d, "package.json");
        if (!shape.paths.includes(pj)) {
          if (shape.paths.includes(rel(d, LOCKFILES[pm]))) lockOnly.push(d);
          continue;
        }
        let baseText, baseLock;
        try {
          baseText = git(["show", `HEAD:${pj}`]);
          baseLock = git(["show", `HEAD:${rel(d, LOCKFILES[pm])}`], { stdio: ["ignore", "pipe", "ignore"] });
        } catch {
          problems.push(`${pj}: no package.json or lockfile on the base commit`);
          continue;
        }
        const claudeText = readFileSync(join(ws, pj), "utf8");
        let lockNames;
        try {
          lockNames = lockPackageNames(pm, baseLock);
        } catch {
          problems.push(`${rel(d, LOCKFILES[pm])}: could not be read on the base commit`);
          continue;
        }
        const built = buildPackageJson(baseText, claudeText, { pm, lockNames, label: pj });
        problems.push(...built.problems);
        if (built.problems.length) continue;
        // The published package.json is built here, never Claude's text.
        writeFileSync(join(ws, pj), built.text);
        if (!built.changed) continue;
        if (/"(workspaces)"\s*:/.test(built.text)) { problems.push(`${pj}: workspaces are not supported`); continue; }
        const rebuilt = rebuildLockfile(d, built.text);
        if (rebuilt !== null) writeFileSync(join(ws, rel(d, LOCKFILES[pm])), rebuilt);
        else continue;
        let downs;
        try {
          downs = lockDowngrades(pm, baseLock, rebuilt);
        } catch {
          problems.push(`${rel(d, LOCKFILES[pm])}: the rebuilt lockfile could not be read`);
          continue;
        }
        if (downs.length) {
          problems.push(`${rel(d, LOCKFILES[pm])}: the change lowers a version. A security fix may only raise versions; a person handles a downgrade. ${downs.slice(0, 10).join("; ")}`);
          continue;
        }
        const before = audit(d, true), after = audit(d, false);
        if (!before || !after) { problems.push(`${pj}: the audit could not run, so the change could not be checked`); continue; }
        // A rise in critical or high findings is refused. A rise in moderate or low
        // can come with a real fix, so it is published with a warning for the reviewer.
        const rose = ["critical", "high", "moderate", "low"].filter((k) => after[k] > before[k]);
        const serious = rose.filter((k) => k === "critical" || k === "high");
        if (serious.length) problems.push(`${pj}: the change raises the audit count for ${serious.join(", ")}`);
        else if (rose.length) warnings.push(`${d === "." ? "" : `\`${d}\`: `}the audit count rose for ${rose.join(", ")}. Check why before merging.`);
        const where = d === "." ? "" : `\`${d}\`: `;
        audits.push(`${where}before: critical ${before.critical}, high ${before.high}, moderate ${before.moderate}, low ${before.low}; after: critical ${after.critical}, high ${after.high}, moderate ${after.moderate}, low ${after.low}`);
      }
    }
    if (!problems.length) {
      git(["add", "-A"]);
      const finalPatch = git(["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"]);
      changed = finalPatch.length > 0;
      writeFileSync(join(outDir, "change.patch"), finalPatch);
      problems.push(...credentialProblems(finalPatch, "the final change"));
      if (changed) {
        const finalShape = patchShapeProblems(git(["apply", "--numstat", "--summary", join(outDir, "change.patch")]));
        problems.push(...finalShape.bad);
      }
    }
  }
  if (!plainFile(join(outDir, "change.patch"))) writeFileSync(join(outDir, "change.patch"), "");

  body = neutralise(body).trim();
  if (warnings.length) body = `**Warning from the workflow:** ${warnings.join(" ")}\n\n${body}`;
  if (audits.length) {
    body += `\n\n---\n**Checked by the workflow.** package.json and the lockfile were rebuilt by the workflow from the dependency versions Claude chose, using ${pm}. Audit measured by the workflow: ${audits.join(". ")}.\n`;
  }
  if (!changed && lockOnly.length) {
    body = `**No change was published.** package.json is unchanged, and lockfile edits are never published: the workflow rebuilds lockfiles from package.json. To fix an indirect package, use an overrides entry.\n\nClaude's notes:\n\n${body}`;
  }
  writeFileSync(join(outDir, "body.md"), body);
  writeFileSync(join(outDir, "title.txt"), title);
  writeFileSync(join(outDir, "base.sha"), baseSha);
  const sha256 = createHash("sha256").update(readFileSync(join(outDir, "change.patch"))).digest("hex");

  out("ok", problems.length ? "false" : "true");
  out("problems", problems.join("\n"));
  out("changed", changed ? "true" : "false");
  out("sha256", sha256);
  out("title", title);
  if (problems.length) {
    console.error("Refused:\n- " + problems.join("\n- "));
    process.exit(1);
  }
  console.log(`Verified. Changed: ${changed}. ${audits.join("; ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    problems.push(`verify failed: ${e.message}`);
    out("ok", "false");
    out("problems", problems.join("\n"));
    console.error("Refused:\n- " + problems.join("\n- "));
    process.exit(1);
  }
}
