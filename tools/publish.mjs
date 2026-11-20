// Publish job: the only job with a write token. No Claude and no package
// manager here. Re-checks the verified change, commits it, pushes the branch,
// opens or updates the pull request and starts CI.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID,
//      PUB_BUNDLE, PUB_WORKSPACE (checkout of base.sha with push credentials),
//      PUB_SHA256 (from verify), PUB_TITLE (from verify), PUB_CHANGED,
//      PUB_MODE (fix|followup), PUB_BRANCH, PUB_ISSUE, PUB_PR, PUB_IDS,
//      PUB_TASK_ID, PUB_RECORD_ID, PUB_TASK_FILE, PUB_CI_WORKFLOWS,
//      PUB_DEFAULT_BRANCH, PUB_PM, PUB_DIRS, PUB_CODE_PATHS, PUB_PROTECTED
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialProblems, neutralise, pathProblems, patchShapeProblems } from "./checks.mjs";
import { SECURITY_BRANCH } from "./gate.mjs";

const env = process.env;
const repo = env.GITHUB_REPOSITORY;
const ws = env.PUB_WORKSPACE;
const bundle = env.PUB_BUNDLE;
const git = (args) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: ws, encoding: "utf8", maxBuffer: 64 << 20 });

async function gh(method, path, body, token = env.GITHUB_TOKEN) {
  const r = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, ok: r.ok, json: text ? JSON.parse(text) : null };
}
// Every comment that ends a run carries this marker, so the Ready to Merge relay
// knows Claude's work on the pull request has finished.
// It names the head the run ended on, so the relay checks the right commit.
const done = (head) => `<!-- claude-security-fix:done head=${head} -->`;
const comment = (n, text) => gh("POST", `issues/${n}/comments`, { body: text });

function fail(why) {
  console.error(why);
  process.exit(1);
}

async function main() {
  const patchPath = join(bundle, "change.patch");
  const plain = (p) => existsSync(p) && lstatSync(p).isFile();
  const patch = plain(patchPath) ? readFileSync(patchPath) : Buffer.alloc(0);
  if (createHash("sha256").update(patch).digest("hex") !== env.PUB_SHA256) fail("The change is not the one verify checked.");
  const body = neutralise(plain(join(bundle, "body.md")) ? readFileSync(join(bundle, "body.md"), "utf8").slice(0, 32000) : "");
  const title = String(env.PUB_TITLE || "").slice(0, 100);
  const issue = Number(env.PUB_ISSUE);
  const followup = env.PUB_MODE === "followup";
  const branch = env.PUB_BRANCH;
  if (!SECURITY_BRANCH.test(branch)) fail(`Unexpected branch name ${branch}.`);
  const baseSha = plain(join(bundle, "base.sha")) ? readFileSync(join(bundle, "base.sha"), "utf8").trim() : "";
  if (baseSha !== git(["rev-parse", "HEAD"]).trim()) fail("The checkout is not the commit the change was made on.");

  // The same cheap checks as verify, again, in case anything changed in between.
  const problems = [
    ...credentialProblems(patch.toString("utf8"), "the change"),
    ...credentialProblems(body, "body.md"),
    ...credentialProblems(title, "title"),
  ];
  if (problems.length) fail(problems.join("\n"));

  if (env.PUB_CHANGED !== "true") {
    const where = followup ? Number(env.PUB_PR) : issue;
    await comment(where, `No change was published on this run.\n\n${body || "(Claude left no notes.)"}\n\n${done("unchanged")}`);
    console.log("No changes. Posted the notes.");
    return;
  }

  const shape = patchShapeProblems(git(["apply", "--numstat", "--summary", patchPath]));
  problems.push(
    ...shape.bad,
    ...pathProblems(shape.paths, {
      pm: env.PUB_PM,
      projectDirs: (env.PUB_DIRS || ".").split(/\s+/).filter(Boolean),
      codePaths: (env.PUB_CODE_PATHS || "").split(/\s+/).filter(Boolean),
      protectedPaths: (env.PUB_PROTECTED || "").split(/\s+/).filter(Boolean),
    })
  );
  if (problems.length) fail(problems.join("\n"));

  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  const ids = String(env.PUB_IDS || "").split(",").filter(Boolean);
  const task = env.PUB_TASK_ID && env.PUB_RECORD_ID ? `${env.PUB_TASK_ID} ${env.PUB_RECORD_ID}` : "";
  const prTitle = `${task ? task + " " : ""}security: ${title}`;

  if (env.PUB_TASK_FILE) {
    if (!/^\.github\/[A-Za-z0-9._-]+$/.test(env.PUB_TASK_FILE)) fail("Unexpected task file path.");
    // The repository's rule: the first commit names the monday task. A follow-up
    // keeps the file in step with the title, in the same commit as the change.
    writeFileSync(join(ws, env.PUB_TASK_FILE), `${prTitle}\n`);
    git(["add", "--", env.PUB_TASK_FILE]);
    if (!followup) git(["commit", "-m", `${task} chore: set the current task`]);
  }
  git(["apply", "--index", patchPath]);
  const msg = [
    `${task ? task + " " : ""}security: ${title}`,
    "",
    `Alerts: ${ids.join(", ")}`,
    `Run: ${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`,
    "",
    "Co-Authored-By: Claude <noreply@anthropic.com>",
  ].join("\n");
  git(["commit", "-m", msg]);
  // A plain push: never forced, so a follow-up fails if the branch moved.
  git(["push", "origin", `HEAD:refs/heads/${branch}`]);
  const sha = git(["rev-parse", "HEAD"]).trim();

  const prBody = `${body.trim()}\n\nCloses #${issue}\n`;
  let pr;
  if (followup) {
    pr = Number(env.PUB_PR);
    await gh("PATCH", `pulls/${pr}`, { title: prTitle, body: prBody });
  } else {
    const made = await gh("POST", "pulls", { title: prTitle, head: branch, base: env.PUB_DEFAULT_BRANCH, body: prBody });
    if (made.ok) pr = made.json.number;
    else {
      // Another workflow (such as Auto PR) may have opened it first.
      const owner = repo.split("/")[0];
      const found = await gh("GET", `pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      pr = found.json?.[0]?.number;
      if (!pr) fail(`Could not open the pull request (${made.status}: ${String(made.json?.message || "").slice(0, 200)}). If it says GitHub Actions is not permitted to create pull requests, turn on "Allow GitHub Actions to create and approve pull requests" in the organisation's and repository's Actions settings. The branch ${branch} was pushed.`);
      await gh("PATCH", `pulls/${pr}`, { title: prTitle, body: prBody });
    }
  }

  // Pull requests and pushes made with this token start no workflows, so start CI directly.
  const notStarted = [];
  for (const wf of String(env.PUB_CI_WORKFLOWS || "").split(/\s+/).filter(Boolean)) {
    const r = await gh("POST", `actions/workflows/${encodeURIComponent(wf)}/dispatches`, { ref: branch });
    if (!r.ok) notStarted.push(`${wf} (${r.status})`);
  }
  const ciLine = notStarted.length ? ` CI could not be started for: ${notStarted.join(", ")}.` : "";
  if (followup) await comment(pr, `Pushed ${sha.slice(0, 7)} with Claude's follow-up changes.${ciLine}\n\n${done(sha)}`);
  else {
    await comment(issue, `Opened #${pr} with Claude's fix.${ciLine}`);
    await comment(pr, `Opened by the Claude security-fix workflow for #${issue}.${ciLine}\n\n${done(sha)}`);
  }
  // Codex does not review pull requests opened by the workflow token, and does not
  // answer the workflow bot. With CODEX_REVIEW_TOKEN (a person's fine-grained token
  // that can only write pull request comments) the request comes from that person.
  if (env.CODEX_REVIEW_TOKEN) {
    const asked = await gh("POST", `issues/${pr}/comments`, { body: "@codex review" }, env.CODEX_REVIEW_TOKEN);
    if (!asked.ok) await comment(pr, `Could not ask Codex to review (${asked.status}). Comment \`@codex review\` to start it.`);
  } else {
    await comment(pr, "Comment `@codex review` to start Codex's review: it does not start on its own for pull requests this workflow opens.");
  }
  console.log(`Published ${sha} to ${branch}, pull request #${pr}.${ciLine}`);
}

main().catch((e) => fail(e.message));
