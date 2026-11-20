# Claude security fix

A shared GitHub Actions workflow that lets Claude Code fix dependency security alerts in npm, pnpm and bun projects. Claude never holds a token that can change the repository.

## How it is kept safe

Claude reads text that other people wrote: repository files, package metadata, audit output and comments. Any of it can try to steer Claude. So the design assumes Claude may be steered, and makes sure a steered Claude can do no harm.

- **Nothing to steal.** Claude's job has a read-only GitHub token. Its shell commands never see GitHub or Actions tokens.
- **Nothing to publish.** A separate job publishes, after checks that do not depend on Claude.
- **Little to change.** Claude may change dependency versions in `package.json`, and small code changes under paths the repository allows. The workflow builds `package.json` and the lockfile itself.

The command guard, the sandbox and the permission rules are a second layer. The design does not depend on them.

## Jobs

| Job | Token | Runs | Does |
| --- | --- | --- | --- |
| gate | read | this kit only | Checks the person asking and the issue author have write access. Reads only GHSA and CVE IDs from the issue. Builds Claude's prompt from fixed text, those IDs, and a follow-up comment from a person with write access. |
| fix | read | Claude | Claude edits files. A hook limits shell commands to `safe-pm audit`, `safe-pm lock` and four git read commands. The sandbox reaches only registry.npmjs.org. The change leaves as a patch, built in a fresh clone from the allowed files only. |
| verify | read | this kit and the package manager | Refuses new, deleted, renamed, binary and linked files, and paths outside the allowed list. Builds `package.json` from the base text plus the versions Claude changed. Refuses added or removed packages, new aliases, tags, downgrades and repeated keys. Rebuilds the lockfile with scripts off and no tokens. Audits before and after, and refuses a rise in critical or high findings. |
| publish | write | this kit only | Checks the change is the one verify built. Commits, pushes (never forced), opens or updates the pull request, starts CI, and asks Codex to review if a token is set. |
| not-started | issues | a fixed message | Says why a fix did not start, when a person with write access asked for one. |
| report | issues | a fixed message | Says if a job failed, with verify's reasons. |

## Set up a repository

1. Copy `examples/claude.yml` to `.github/workflows/claude-security-fix.yml`. Pin `uses:` and `tools-ref` to the same full commit SHA of this repository.
2. Set `package-manager`, `project-dirs` and, if wanted, `code-paths` and `protected-paths`.
3. Add `workflow_dispatch:` to each CI workflow named in `ci-workflows`. Pull requests opened by a workflow do not start CI by themselves. CI runs the branch's code, and its install step runs the new package versions, as it does for any dependency update. So keep secrets out of those workflows and give them read-only permissions. To read every dependency change before any CI runs, leave `ci-workflows` empty and start CI by hand. If a change includes source files (only possible with `code-paths`), the workflow does not start CI: a person reads the diff and starts it.
4. In the organisation's Actions settings, tick "Allow GitHub Actions to create and approve pull requests".
5. Give the repository the `CLAUDE_CODE_OAUTH_TOKEN` secret.
6. Optional: add `CODEX_REVIEW_TOKEN`, a fine-grained token with only "Pull requests: read and write" on that repository. The publish job uses it to post `@codex review`.

## Start a fix

Open an issue that mentions `@claude`, lists the GHSA or CVE IDs, and has the `security` label. To ask for more on the pull request it opens, comment there and mention `@claude`.

## Tests

- `node test/unit.mjs`: the guard and every check.
- `test/integration.sh`: the real package managers, a real fix and the attacks found in review. CI runs it for npm, pnpm and bun.
- `test/tools-hash.sh --check`: the workflow pins the tools at the same commit.
