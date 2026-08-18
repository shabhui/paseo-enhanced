import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectoryNames = new Set([".git", "build", "data", "node_modules"]);
function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const filePath = path.join(directory, name);
    const entry = lstatSync(filePath);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) {
      if (skippedDirectoryNames.has(name) || name.startsWith(".codex-")) return [];
      return walk(filePath);
    }
    return [filePath];
  });
}

for (const filePath of walk(root).filter((name) => name.endsWith(".js") || name.endsWith(".mjs"))) {
  execFileSync(process.execPath, ["--check", filePath], { stdio: "inherit" });
}
console.log("JavaScript syntax checks passed.");
