// safe-pm's package.json check: one copy of each key, registry versions only.
// Usage: node safe-pm-check.mjs <package.json>
import { readJsonFile, registryProblems } from "./checks.mjs";

try {
  const bad = registryProblems(readJsonFile(process.argv[2]));
  if (bad.length) {
    console.error("safe-pm: only npm registry versions are allowed:\n  " + bad.join("\n  "));
    process.exit(1);
  }
} catch (e) {
  console.error("safe-pm: " + e.message);
  process.exit(1);
}
