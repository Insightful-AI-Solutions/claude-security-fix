// Fix job: writes Claude Code's settings JSON for this runner and prints the
// extra directories Claude's sandboxed commands need to read.
//
// The settings turn on the sandbox (fail closed), let sandboxed commands write
// only the workspace and safe-pm's cache, reach only registry.npmjs.org, and
// never see GitHub or Actions tokens. File tools cannot read outside the working
// directories. A PreToolUse hook guards shell commands.
//
// Env: CS_WORKSPACE, CS_ROOT (bin, kit, pm-base: read-only), CS_CACHE (safe-pm's cache), GITHUB_OUTPUT
import { appendFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, sep } from "node:path";
import { homedir } from "node:os";

const env = process.env;
const root = env.CS_ROOT;
const ok = (p) => /^\/[A-Za-z0-9._\/-]+$/.test(p);
for (const p of [env.CS_WORKSPACE, root, env.CS_CACHE]) if (!ok(p)) throw new Error(`unexpected path ${p}`);

// Package-manager installs under the home folder (pnpm/action-setup, setup-bun)
// must stay readable, because the read block hides /home from sandboxed commands.
const home = homedir();
const extra = new Set([root]);
for (const tool of ["node", "npm", "pnpm", "bun"]) {
  let p;
  try {
    p = realpathSync(execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim());
  } catch {
    continue;
  }
  if (p.startsWith(home + sep)) {
    const top = home + sep + p.slice(home.length + 1).split(sep)[0];
    if (ok(top) && top !== home) extra.add(top);
  } else if (p.startsWith("/home/")) {
    extra.add(dirname(dirname(p)));
  }
}

const deny = (name) => ({ name, mode: "deny" });
const settings = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { allowWrite: [env.CS_WORKSPACE, env.CS_CACHE] },
    // allowAllUnixSockets skips the sandbox's unix-socket seccomp layer, which
    // cannot start on GitHub's Ubuntu 24.04 runners (nested user namespace). The
    // workflow stops Docker first, so no powerful socket is left to reach.
    network: { allowedDomains: ["registry.npmjs.org"], allowAllUnixSockets: true },
    credentials: {
      envVars: ["GH_TOKEN", "GITHUB_TOKEN", "DEFAULT_WORKFLOW_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_RESULTS_URL", "ACTIONS_CACHE_URL"].map(deny),
    },
  },
  permissions: { blockReadsOutsideWorkingDirectories: true },
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${root}/bin/claude-bash-guard` }] }],
  },
};
const json = JSON.stringify(settings);
if (json.includes("'")) throw new Error("settings must not contain a single quote");
const dirsArg = [...extra].map((d) => `--add-dir ${d}`).join(" ");
appendFileSync(env.GITHUB_OUTPUT, `json=${json}\nadd_dirs=${dirsArg}\n`);
console.log(json);
console.log(dirsArg);
