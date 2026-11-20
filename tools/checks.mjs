// Checks shared by the fix job's safe-pm and packaging, verify and publish. No dependencies.
import { lstatSync, readFileSync } from "node:fs";

export const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
export const LOCKFILES = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", bun: "bun.lock" };
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

// ---------- JSON ----------

// JSON.parse keeps the last copy of a repeated key; bun keeps the first. A file
// with repeated keys can therefore mean different things to different tools, so
// it is refused.
export function parseStrictJson(text) {
  const s = String(text);
  let i = 0;
  const ws = () => { while (i < s.length && " \t\n\r".includes(s[i])) i++; };
  const str = () => {
    const start = i;
    i++;
    while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(s.slice(start, i));
  };
  const value = (path) => {
    ws();
    if (s[i] === "{") {
      i++;
      const keys = new Set();
      ws();
      if (s[i] === "}") { i++; return; }
      for (;;) {
        ws();
        if (s[i] !== '"') throw new Error(`bad JSON at ${path}`);
        const k = str();
        if (keys.has(k)) throw new Error(`repeated key "${String(k).slice(0, 60)}" at ${path}`);
        keys.add(k);
        ws();
        if (s[i++] !== ":") throw new Error(`bad JSON at ${path}`);
        value(`${path}.${String(k).slice(0, 60)}`);
        ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return; }
        throw new Error(`bad JSON at ${path}`);
      }
    }
    if (s[i] === "[") {
      i++;
      ws();
      if (s[i] === "]") { i++; return; }
      for (let n = 0; ; n++) {
        value(`${path}[${n}]`);
        ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return; }
        throw new Error(`bad JSON at ${path}`);
      }
    }
    if (s[i] === '"') { str(); return; }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
    if (!m) throw new Error(`bad JSON at ${path}`);
    i += m[0].length;
  };
  value("$");
  ws();
  if (i !== s.length) throw new Error("bad JSON: extra text at the end");
  return JSON.parse(s);
}

// Reads a JSON file as data. Refuses links and anything that is not a plain file.
export function readJsonFile(path, { optional = false } = {}) {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (e.code === "ENOENT" && optional) return null;
    throw new Error(`${path}: missing`);
  }
  if (!st.isFile()) throw new Error(`${path}: must be a plain file, not a link`);
  return parseStrictJson(readFileSync(path, "utf8"));
}

// ---------- versions ----------

// A semver range only: no dist-tags, protocols, paths or GitHub shorthands.
const COMPARATOR = /^(?:<=|>=|<|>|=|~|\^)?v?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function isSemverRange(spec) {
  if (typeof spec !== "string") return false;
  const s = spec.trim();
  if (s === "" || s === "*") return true;
  if (s.length > 200) return false;
  return s.split("||").every((part) => {
    const p = part.trim().replace(/(<=|>=|<|>|=|~|\^)\s+/g, "$1");
    if (p === "" || p === "*") return true;
    const hy = /^(\S+)\s+-\s+(\S+)$/.exec(p);
    if (hy) return COMPARATOR.test(hy[1]) && COMPARATOR.test(hy[2]);
    return p.split(/\s+/).every((c) => COMPARATOR.test(c));
  });
}

// True when a range has no upper limit: "*", "x", ">=1.2.3" or ">1". A fix must
// name the version it wants. An open range would take whatever is newest.
export function openEnded(range) {
  const s = String(range ?? "").trim();
  if (s === "" || s === "*") return true;
  return s.split("||").some((part) => {
    const p = part.trim().replace(/(<=|>=|<|>|=|~|\^)\s+/g, "$1");
    if (p === "" || /^v?[xX*](?:\.[xX*]){0,2}$/.test(p)) return true;
    if (/\s-\s/.test(p)) return false; // "1.0.0 - 2.0.0" has an upper limit
    const parts = p.split(/\s+/);
    return parts.some((c) => /^>=?/.test(c)) && !parts.some((c) => /^<=?/.test(c));
  });
}

// True when a range starts at a lower version than the range it replaces.
const firstVersion = (range) => {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(range));
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};
export function lowers(oldRange, newRange) {
  const a = firstVersion(oldRange), b = firstVersion(newRange);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] < a[i];
  return false;
}

// "npm:<name>@<range>", any letter case, as npm reads it.
export function parseAlias(spec) {
  if (typeof spec !== "string") return null;
  const m = /^\s*npm:((?:@[^@/\s]+\/)?[^@\s]+)@(.*)$/i.exec(spec);
  return m ? { name: m[1].toLowerCase(), range: m[2] } : null;
}

// Every value in package.json's dependency maps and overrides must be a registry
// semver range (or an alias the default branch already has). Used by safe-pm,
// so Claude learns early; verify applies the full rules below.
export function registryProblems(pkg, label = "package.json") {
  const bad = [];
  const plain = (v) => isSemverRange(v) || (parseAlias(v) && isSemverRange(parseAlias(v).range));
  for (const f of DEP_FIELDS) {
    for (const [k, v] of Object.entries(pkg?.[f] || {})) if (!plain(v)) bad.push(`${label} ${f}.${k.slice(0, 80)}: not a registry version range`);
  }
  const walk = (o, at) => {
    for (const [k, v] of Object.entries(o || {})) {
      if (v && typeof v === "object") walk(v, `${at}.${k.slice(0, 80)}`);
      else if (!(isSemverRange(v) || /^\$[a-z0-9@/._~-]+$/i.test(String(v)))) bad.push(`${label} ${at}.${k.slice(0, 80)}: not a registry version range`);
    }
  };
  walk(pkg?.overrides, "overrides");
  walk(pkg?.resolutions, "resolutions");
  walk(pkg?.pnpm?.overrides, "pnpm.overrides");
  return bad;
}

// ---------- lockfile package names ----------

// Package names present in a lockfile on the default branch. Overrides may name
// only these, so a fix cannot bring in a package the project never had.
function stripJsonc(text) {
  let out = "", inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && " \t\r\n".includes(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += c;
  }
  return out;
}
export function lockPackageNames(pm, text) {
  const names = new Set();
  if (!text) return names;
  if (pm === "npm") {
    const l = JSON.parse(text);
    for (const [k, v] of Object.entries(l.packages || {})) {
      if (!k) continue;
      names.add(k.slice(k.lastIndexOf("node_modules/") + 13).toLowerCase());
      if (v?.name) names.add(String(v.name).toLowerCase());
    }
    // lockfileVersion 1 has no "packages" map: names sit in a nested "dependencies" tree.
    const walk = (deps, depth) => {
      if (!deps || typeof deps !== "object" || depth > 50) return;
      for (const [k, v] of Object.entries(deps)) {
        names.add(k.toLowerCase());
        walk(v?.dependencies, depth + 1);
      }
    };
    walk(l.dependencies, 0);
  } else if (pm === "bun") {
    const l = JSON.parse(stripJsonc(text));
    for (const [k, v] of Object.entries(l.packages || {})) {
      names.add(k.split("/").slice(-1)[0].toLowerCase());
      if (k.startsWith("@")) names.add(k.split("/").slice(0, 2).join("/").toLowerCase());
      const first = Array.isArray(v) ? String(v[0]) : "";
      const at = first.lastIndexOf("@");
      if (at > 0) names.add(first.slice(0, at).toLowerCase());
    }
  } else if (pm === "pnpm") {
    for (const line of text.split("\n")) {
      // Newer lockfiles write "name@1.0.0". Older ones write "/name@1.0.0" or "/name/1.0.0".
      const m = /^ {2}'?\/?((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@|\/\d)/i.exec(line);
      if (m) names.add(m[1].toLowerCase());
    }
  }
  return names;
}

// Every version of every package in a lockfile: Map of name -> versions.
// Entries without a plain version (links, git sources) are left out.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function lockVersions(pm, text) {
  const map = new Map();
  const add = (name, version) => {
    const v = String(version ?? "");
    if (!name || !VERSION.test(v)) return;
    const n = String(name).toLowerCase();
    if (!map.has(n)) map.set(n, new Set());
    map.get(n).add(v.replace(/\+.*$/, ""));
  };
  if (!text) return map;
  if (pm === "npm") {
    const l = JSON.parse(text);
    for (const [k, v] of Object.entries(l.packages || {})) {
      if (!k || v?.link) continue;
      add(v?.name || k.slice(k.lastIndexOf("node_modules/") + 13), v?.version);
    }
    const walk = (deps, depth) => {
      if (!deps || typeof deps !== "object" || depth > 50) return;
      for (const [k, v] of Object.entries(deps)) {
        if (!l.packages) add(k, v?.version);
        walk(v?.dependencies, depth + 1);
      }
    };
    walk(l.dependencies, 0);
  } else if (pm === "bun") {
    const l = JSON.parse(stripJsonc(text));
    for (const v of Object.values(l.packages || {})) {
      const first = Array.isArray(v) ? String(v[0]) : "";
      const at = first.lastIndexOf("@");
      if (at > 0) add(first.slice(0, at), first.slice(at + 1));
    }
  } else if (pm === "pnpm") {
    for (const line of text.split("\n")) {
      const m = /^ {2}'?\/?((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)[@\/](\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=[(_:'+]|$)/i.exec(line);
      if (m) add(m[1], m[2]);
    }
  }
  return map;
}

// Orders two plain versions, as semver does. A pre-release sorts before its release.
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v));
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : null } : null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// The version at each place in a lockfile: Map of place -> version. A place is a
// folder in the installed tree (npm, Bun) or a project's own dependency (pnpm).
// Comparing place by place catches a copy that goes down while another goes up.
export function lockResolutions(pm, text) {
  const map = new Map();
  const put = (place, version) => {
    const v = String(version ?? "").replace(/^'|'$/g, "").replace(/[(_+].*$/, "");
    if (VERSION.test(v)) map.set(place, v);
  };
  if (!text) return map;
  if (pm === "npm") {
    const l = JSON.parse(text);
    for (const [k, v] of Object.entries(l.packages || {})) if (k && !v?.link) put(k, v?.version);
    const walk = (deps, at, depth) => {
      if (!deps || typeof deps !== "object" || depth > 50) return;
      for (const [k, v] of Object.entries(deps)) {
        if (!l.packages) put(`${at}node_modules/${k}`, v?.version);
        walk(v?.dependencies, `${at}node_modules/${k}/`, depth + 1);
      }
    };
    walk(l.dependencies, "", 0);
  } else if (pm === "bun") {
    const l = JSON.parse(stripJsonc(text));
    for (const [k, v] of Object.entries(l.packages || {})) {
      const first = Array.isArray(v) ? String(v[0]) : "";
      const at = first.lastIndexOf("@");
      if (at > 0) put(k, first.slice(at + 1));
    }
  } else if (pm === "pnpm") {
    // Each project's own dependencies: under "importers:" in newer lockfiles, or at
    // the top level in older single-project ones.
    const FIELD = /^(dependencies|devDependencies|optionalDependencies):\s*$/;
    let importer = null, field = null, name = null, inImporters = false;
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (!line.trim()) continue;
      const indent = line.length - line.trimStart().length;
      const body = line.trim();
      if (indent === 0) {
        inImporters = body === "importers:";
        importer = inImporters ? null : ".";
        field = !inImporters && FIELD.test(body) ? body.slice(0, -1) : null;
        name = null;
        continue;
      }
      const kv = /^'?([^':]+(?::[^':]+)*?)'?:\s*(.*)$/.exec(body);
      if (inImporters) {
        if (indent === 2) { importer = body.replace(/:$/, "").replace(/^'|'$/g, ""); field = null; }
        else if (indent === 4) field = FIELD.test(body) ? body.replace(/:\s*$/, "") : null;
        else if (indent === 6 && field && kv) { name = kv[1]; if (kv[2]) put(`${importer}|${name}`, kv[2]); }
        else if (indent === 8 && field && name && kv && kv[1] === "version") put(`${importer}|${name}`, kv[2]);
      } else if (field) {
        if (indent === 2 && kv) { name = kv[1]; if (kv[2]) put(`.|${name}`, kv[2]); }
        else if (indent === 4 && name && kv && kv[1] === "version") put(`.|${name}`, kv[2]);
      }
    }
  }
  return map;
}

// The real test for a downgrade: compare what the two lockfiles resolve to.
// First place by place. Then, for each package, neither its lowest nor its highest
// version may go down. This catches any range wording that would pull an older
// release in.
export function lockDowngrades(pm, baseLock, newLock) {
  const bad = [];
  const was = lockResolutions(pm, baseLock), now = lockResolutions(pm, newLock);
  for (const [place, v] of was) {
    const nv = now.get(place);
    if (nv && compareVersions(nv, v) < 0) bad.push(`${place.replace(/^.*node_modules\//, "").replace(/^.*\|/, "")} goes down from ${v} to ${nv} at ${place}`);
  }
  if (bad.length) return bad;
  const before = lockVersions(pm, baseLock), after = lockVersions(pm, newLock);
  const ends = (set) => {
    const list = [...set].sort(compareVersions);
    return [list[0], list[list.length - 1]];
  };
  for (const [name, versions] of before) {
    if (!after.has(name)) continue;
    const [lo, hi] = ends(versions), [nlo, nhi] = ends(after.get(name));
    if (compareVersions(nhi, hi) < 0) bad.push(`${name} goes down from ${hi} to ${nhi}`);
    else if (compareVersions(nlo, lo) < 0) bad.push(`${name} gains an older version, ${nlo} (the lowest was ${lo})`);
  }
  return bad;
}

// ---------- package.json ----------

// Names in an override key: "a", "a@^1", "@s/a@1", pnpm's "parent>child" and npm's ".".
function overrideKeyNames(key) {
  return String(key).split(">").map((part) => {
    const p = part.trim();
    if (p === ".") return ".";
    const at = p.startsWith("@") ? p.indexOf("@", 1) : p.indexOf("@");
    const name = at > 0 ? p.slice(0, at) : p;
    const range = at > 0 ? p.slice(at + 1) : "";
    if (!NAME.test(name) || (range && !isSemverRange(range))) return null;
    return name.toLowerCase();
  });
}

function overridesProblems(ov, label, { lockNames, directNames, nested }) {
  const bad = [];
  if (ov === undefined) return bad;
  if (!ov || typeof ov !== "object" || Array.isArray(ov)) return [`${label}: must be an object`];
  const walk = (o, at, depth) => {
    for (const [k, v] of Object.entries(o)) {
      const names = overrideKeyNames(k);
      if (names.some((n) => n === null)) { bad.push(`${at}: a key is not a package name`); continue; }
      if (names.some((n) => n === "." && (!nested || depth === 0))) { bad.push(`${at}: "." is only allowed inside a nested override`); continue; }
      const unknown = names.filter((n) => n !== "." && !lockNames.has(n));
      if (unknown.length) { bad.push(`${at}: names a package the project does not have (${unknown.join(", ").slice(0, 120)})`); continue; }
      if (v && typeof v === "object") {
        if (!nested || depth >= 2) bad.push(`${at}: nested overrides are not allowed here`);
        else walk(v, `${at}.${k.slice(0, 80)}`, depth + 1);
      } else if (!(isSemverRange(v) || (typeof v === "string" && v.startsWith("$") && directNames.has(v.slice(1).toLowerCase())))) {
        bad.push(`${at}.${k.slice(0, 80)}: not a registry version range`);
      }
    }
  };
  walk(ov, label, 0);
  return bad;
}

// A new or changed override must name the version it wants.
function openOverrideProblems(baseOv, nextOv, label) {
  const bad = [];
  const walk = (b, n, at, depth) => {
    if (!n || typeof n !== "object" || Array.isArray(n) || depth > 5) return;
    for (const [k, v] of Object.entries(n)) {
      const bv = b && typeof b === "object" ? b[k] : undefined;
      if (v && typeof v === "object") walk(bv, v, `${at}.${k.slice(0, 80)}`, depth + 1);
      else if (typeof v === "string" && v !== bv && !v.startsWith("$") && openEnded(v)) {
        bad.push(`${at}.${k.slice(0, 80)}: the new range has no upper limit. Name the fixed version, for example ^1.2.3`);
      }
    }
  };
  walk(baseOv, nextOv, label, 0);
  return bad;
}

// An override may not move to a lower version than the one it replaces.
function overrideDowngrades(baseOv, nextOv, label) {
  const bad = [];
  const walk = (b, n, at, depth) => {
    if (!b || typeof b !== "object" || !n || typeof n !== "object" || depth > 5) return;
    for (const [k, v] of Object.entries(b)) {
      const nv = n[k];
      if (v && typeof v === "object") walk(v, nv, `${at}.${k.slice(0, 80)}`, depth + 1);
      else if (typeof v === "string" && typeof nv === "string" && nv !== v && lowers(v, nv)) {
        bad.push(`${at}.${k.slice(0, 80)}: lowers the version. A security fix may only raise versions; a person handles a downgrade`);
      }
    }
  };
  walk(baseOv, nextOv, label, 0);
  return bad;
}

// An existing override that points at git, a URL, a file or a workspace must stay
// exactly as it is. Changing or removing it would change where the code comes from.
function sourceOverrideProblems(baseOv, nextOv, label) {
  const bad = [];
  const walk = (b, n, at, depth) => {
    if (!b || typeof b !== "object" || Array.isArray(b) || depth > 5) return;
    for (const [k, v] of Object.entries(b)) {
      const nv = n && typeof n === "object" ? n[k] : undefined;
      if (v && typeof v === "object") walk(v, nv, `${at}.${k.slice(0, 80)}`, depth + 1);
      else if (typeof v === "string" && !isSemverRange(v) && !v.startsWith("$") && nv !== v) {
        bad.push(`${at}.${k.slice(0, 80)}: does not come from the registry, so it may not change. A person handles it`);
      }
    }
  };
  walk(baseOv, nextOv, label, 0);
  return bad;
}

const stable = (v) =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",")}}`
    : JSON.stringify(v);

// Builds the package.json that is published, from the default branch's text
// plus only the dependency changes Claude made. Claude's own text is never
// published. Any change outside dependency versions and overrides is refused.
//
// Allowed: a new range for a package already listed; adding, changing or removing
// overrides for packages already in the lockfile. Refused: added or removed
// dependencies, new aliases, dist-tags and anything that is not a semver range,
// repeated keys, and any other field.
export function buildPackageJson(baseText, claudeText, { pm, lockNames, label = "package.json" }) {
  const problems = [];
  let base, next;
  try {
    base = parseStrictJson(baseText);
  } catch (e) {
    return { problems: [`${label} on the default branch: ${e.message}`] };
  }
  try {
    next = parseStrictJson(claudeText);
  } catch (e) {
    return { problems: [`${label}: ${e.message}`] };
  }
  // This workflow handles npm registry packages only. A project that takes code
  // from git, a URL, a file or a workspace is out of scope: its lockfile could not
  // be rebuilt here without fetching from those places.
  const baseSources = registryProblems(base, label);
  if (baseSources.length) {
    return { problems: [`${label} on the default branch uses a source that is not an npm registry version (${baseSources.length} found). This workflow only handles registry packages, so a person handles this fix`] };
  }
  const out = JSON.parse(JSON.stringify(base));
  const directNames = new Set();

  for (const f of DEP_FIELDS) {
    const b = base[f] || {}, n = next[f] || {};
    const bk = Object.keys(b).sort().join("\n"), nk = Object.keys(n).sort().join("\n");
    if (bk !== nk) { problems.push(`${label} ${f}: packages may not be added or removed`); continue; }
    for (const name of Object.keys(b)) {
      directNames.add(name.toLowerCase());
      if (n[name] === b[name]) continue;
      const ba = parseAlias(b[name]), na = parseAlias(n[name]);
      if (ba || na) {
        if (!ba || !na || ba.name !== na.name || !isSemverRange(na.range)) {
          problems.push(`${label} ${f}.${name.slice(0, 80)}: an alias may only change its version range`);
          continue;
        }
      } else if (!isSemverRange(n[name])) {
        problems.push(`${label} ${f}.${name.slice(0, 80)}: not a semver range`);
        continue;
      } else if (!isSemverRange(b[name])) {
        // git, URL, file and workspace sources are not the registry package of the
        // same name. Swapping one for a registry range could pull in a stranger's code.
        problems.push(`${label} ${f}.${name.slice(0, 80)}: does not come from the registry, so its source may not change. A person handles it`);
        continue;
      }
      if (openEnded(na ? na.range : n[name])) {
        problems.push(`${label} ${f}.${name.slice(0, 80)}: the new range has no upper limit. Name the fixed version, for example ^1.2.3`);
        continue;
      }
      if (lowers(ba ? ba.range : b[name], na ? na.range : n[name])) {
        problems.push(`${label} ${f}.${name.slice(0, 80)}: lowers the version. A security fix may only raise versions; a person handles a downgrade`);
        continue;
      }
      out[f][name] = n[name];
    }
  }

  const ovFields = pm === "pnpm" ? [] : ["overrides", "resolutions"];
  for (const f of ovFields) {
    problems.push(...sourceOverrideProblems(base[f], next[f], `${label} ${f}`));
    problems.push(...overrideDowngrades(base[f], next[f], `${label} ${f}`));
    problems.push(...openOverrideProblems(base[f], next[f], `${label} ${f}`));
    problems.push(...overridesProblems(next[f], `${label} ${f}`, { lockNames, directNames, nested: f === "overrides" && pm === "npm" }));
    if (next[f] === undefined) delete out[f];
    else out[f] = next[f];
  }
  if (pm === "pnpm") {
    problems.push(...sourceOverrideProblems(base.pnpm?.overrides, next.pnpm?.overrides, `${label} pnpm.overrides`));
    problems.push(...overrideDowngrades(base.pnpm?.overrides, next.pnpm?.overrides, `${label} pnpm.overrides`));
    problems.push(...openOverrideProblems(base.pnpm?.overrides, next.pnpm?.overrides, `${label} pnpm.overrides`));
    problems.push(...overridesProblems(next.pnpm?.overrides, `${label} pnpm.overrides`, { lockNames, directNames, nested: false }));
    if (next.pnpm?.overrides === undefined) {
      if (out.pnpm) delete out.pnpm.overrides;
      if (out.pnpm && !Object.keys(out.pnpm).length) delete out.pnpm;
    } else {
      out.pnpm = { ...(out.pnpm || {}), overrides: next.pnpm.overrides };
    }
  } else if (stable(next.pnpm) !== stable(base.pnpm)) {
    problems.push(`${label} pnpm: may not change`);
  }

  // Everything else must be exactly as on the default branch.
  const rest = (p) => {
    const c = JSON.parse(JSON.stringify(p || {}));
    for (const f of [...DEP_FIELDS, "overrides", "resolutions"]) delete c[f];
    if (c.pnpm) { delete c.pnpm.overrides; if (!Object.keys(c.pnpm).length) delete c.pnpm; }
    return c;
  };
  if (stable(rest(base)) !== stable(rest(next))) {
    problems.push(`${label}: only dependency versions and overrides may change (scripts, config and other fields must stay the same)`);
  }
  if (problems.length) return { problems };

  const indent = (/\n([ \t]+)"/.exec(baseText) || [, "  "])[1];
  const text = JSON.stringify(out, null, indent) + (baseText.endsWith("\n") ? "\n" : "");
  return { problems, text, changed: text !== baseText };
}

// ---------- text that gets published ----------

const CREDENTIAL_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /x-access-token/i,
  /authorization:\s*(basic|bearer|token)\s/i,
  /sk-ant-[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
export function credentialProblems(text, label) {
  return CREDENTIAL_PATTERNS.some((re) => re.test(text)) ? [`${label}: looks like it holds a credential`] : [];
}

// Claude's text goes into a pull request and comments that the bot posts. It
// must not close or link issues, mention people, load images or carry HTML.
export function neutralise(text) {
  return String(text)
    .replace(/\r/g, "")
    .replace(/[​-‏‪-‮⁦-⁩]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/</g, "&lt;")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "[image removed: $1]")
    // Any other image form, such as ![x][ref] with a [ref]: URL line. Without the
    // "!" it is a plain link, which nothing loads until a person clicks it.
    .replace(/!+(?=\[)/g, "")
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)((?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/\S+\/(?:issues|pull)\/\d+)/gi, "$1$2(link removed)")
    .replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*)/g, "$1@​$2");
}

// One short printable line.
export function cleanTitle(raw) {
  const t = String(raw ?? "").split("\n")[0].replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();
  return neutralise(t.replace(/^security:\s*/i, "")).replace(/​/g, "").replace(/@/g, "").slice(0, 100);
}

// ---------- paths ----------

export const ALWAYS_PROTECTED = [
  ".github/", ".git/", ".gitattributes", ".gitmodules", ".npmrc", ".yarnrc", ".yarnrc.yml",
  ".pnpmfile.cjs", ".pnpmfile.mjs", "pnpm-workspace.yaml", "bunfig.toml", "npm-shrinkwrap.json",
  "netlify.toml", "netlify/", "supabase/", "CLAUDE.md", "AGENTS.md", ".claude/", ".mcp.json",
  ".husky/", ".nvmrc", ".bun-version", ".node-version", ".tool-versions", "patches/",
];

const rel = (dir, f) => (dir === "." ? f : `${dir.replace(/\/$/, "")}/${f}`);
export const normCodePaths = (list) => list.filter(Boolean).map((c) => (c.endsWith("/") ? c : c + "/"));

export function dependencyFiles(pm, projectDirs) {
  const deps = new Set();
  for (const d of projectDirs) {
    deps.add(rel(d, "package.json"));
    deps.add(rel(d, LOCKFILES[pm]));
  }
  return deps;
}

export function pathProblems(paths, { pm, projectDirs, codePaths = [], protectedPaths = [] }) {
  const bad = [];
  const deps = dependencyFiles(pm, projectDirs);
  const prot = [...ALWAYS_PROTECTED, ...protectedPaths];
  const code = normCodePaths(codePaths);
  const hits = (p, list) =>
    list.some((x) => {
      const leaf = p.split("/").pop();
      if (x.endsWith("/")) return p.startsWith(x) || p.includes("/" + x);
      // A name with no "/" at the end can be a file or a folder. Cover both.
      return p === x || leaf === x || p.startsWith(x + "/");
    });
  for (const p of paths) {
    if (!/^[A-Za-z0-9._@+\-\/]+$/.test(p) || p.split("/").some((s) => s === ".." || s === "" || s === ".")) {
      bad.push("a changed path has unusual characters");
      continue;
    }
    if (deps.has(p)) {
      // A path the repository itself protects wins over the dependency allowlist.
      if (hits(p, protectedPaths)) bad.push(`${p}: protected, a security fix may not change it`);
      continue;
    }
    if (hits(p, prot)) bad.push(`${p}: protected, a security fix may not change it`);
    else if (!code.some((c) => p.startsWith(c))) bad.push(`${p}: outside the paths a security fix may change`);
  }
  return bad;
}

// Parses `git apply --numstat --summary`. A fix edits existing text files only.
export function patchShapeProblems(numstatSummary) {
  const bad = [];
  const paths = [];
  for (const line of numstatSummary.split("\n")) {
    if (!line.trim()) continue;
    const num = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (num) {
      if (num[1] === "-" || num[2] === "-") bad.push("binary changes are not allowed");
      paths.push(num[3]);
      continue;
    }
    if (/^\s*(create|delete) mode/.test(line)) bad.push("new or deleted files are not allowed");
    else if (/^\s*(rename|copy) /.test(line)) bad.push("renames are not allowed");
    else if (/^\s*mode change/.test(line)) bad.push("mode changes are not allowed");
    else bad.push("unexpected patch summary line");
  }
  if (/\b120000\b/.test(numstatSummary)) bad.push("symlinks are not allowed");
  return { bad: [...new Set(bad)], paths };
}
