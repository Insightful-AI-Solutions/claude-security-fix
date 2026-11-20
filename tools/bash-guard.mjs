#!/usr/bin/env node
// PreToolUse hook for Claude's Bash tool in the fix job.
//
// Claude Code runs some read-only commands (cat, grep, echo, read-only git)
// in every permission mode, and a deny rule does not catch the same program by
// another path. This hook is the boundary: a Bash call runs only if it is one
// of the exact commands below. Exit code 2 blocks the call before any
// permission rule is checked, and Claude sees the message on stderr.
//
// SAFE_PM_DIRS (space-separated, set by the workflow) lists the project
// folders safe-pm may work in, for example ". scripts/baseline".
import { readFileSync } from "node:fs";

const dirList = () => (process.env.SAFE_PM_DIRS || ".").split(/\s+/).filter(Boolean);

export function allowed(command) {
  const cmd = String(command ?? "").trim();
  const dirs = dirList();
  const exact = new Set([
    "git status",
    "git diff",
    "git diff --staged",
    "git log --oneline -20",
  ]);
  for (const verb of ["audit", "lock"]) {
    exact.add(`safe-pm ${verb}`);
    for (const d of dirs) exact.add(`safe-pm ${verb} ${d}`);
  }
  return exact.has(cmd);
}

function help() {
  const pm = dirList().map((d) => (d === "." ? "" : " " + d));
  return (
    "Allowed Bash commands: " +
    [...new Set(pm)].map((d) => `safe-pm audit${d} | safe-pm lock${d}`).join(" | ") +
    " | git status | git diff | git diff --staged | git log --oneline -20. " +
    "Use the Read, Grep and Glob tools to read files, and Edit or Write to change them. " +
    "The workflow commits, pushes and opens the pull request for you."
  );
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.stderr.write("Blocked: the command guard could not read its input.\n");
    process.exit(2);
  }
  // Other shell-like tools are never needed.
  if (["PowerShell", "Monitor", "BashOutput", "KillShell"].includes(input.tool_name)) {
    process.stderr.write(`Blocked by the workflow's command guard: ${input.tool_name} is not used in this job.\n`);
    process.exit(2);
  }
  if (input.tool_name !== "Bash") process.exit(0);
  const cmd = (input.tool_input || {}).command;
  if (allowed(cmd)) process.exit(0);
  process.stderr.write("Blocked by the workflow's command guard. " + help() + "\n");
  process.exit(2);
}
